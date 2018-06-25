const fs                = require('fs');
const path              = require('path');

const bodyParser        = require('body-parser');
const config            = require('config');
const express           = require('express');
const filepreview       = require('filepreview-es6');
const kue               = require('kue');
const passport          = require('passport');
const Strategy          = require('passport-http').BasicStrategy;
const request           = require('request');
const syncrequest       = require('sync-request');
const tmp               = require('tmp');
const util              = require('util');
const winston           = require('winston');
const DailyRotateFile   = require('winston-daily-rotate-file');
const xml2js            = require('xml2js');

const users             = require('./users');
const mimetypes         = require('./mimetype.json');



const app = express();
app.use(bodyParser.json())

let appConfig = config.get('app');


passport.use(new Strategy(
    function(username, password, callback) {
        users.findByUsername(username, function(error, user) {
            if (error) { return callback(error); }
            if (!user) { return callback(null, false); }
            if (user.password != password) { return callback(null, false); }
            return callback(null, user);
        });
    }
));


const logLevel = (process.env.NODE_ENV == 'production' ? "error" : "info");
const logger = winston.createLogger({
    level: logLevel,
    transports: [
        new winston.transports.Console(),
        new DailyRotateFile({
            filename: 'application-%DATE%.log',
            datePattern: 'YYYY-MM-DD-HH',
            zippedArchive: true,
            maxSize: '20m',
            maxFiles: '14d'
        })
    ]
});


const filePreviewQueue = kue.createQueue(config.get('jobqueue'));
filePreviewQueue.process('filePreview', function (job, done) {
    logger.info('processing job: ' + job.id);
    handleFilePreview(
        job.data.options,
        job.data.download_url,
        job.data.ext,
        job.data.signed_s3_url,
        done
    );
});


app.post('/filepreview', passport.authenticate('basic', { session: false }), function (req, res) {
    if (!req.body.callback_url) return res.status(422).send({error: 'request must contain callback_url'})
    if (!req.body.download_url) return res.status(422).send({error: 'request must contain download_url'})
    if (!req.body.signed_s3_url) return res.status(422).send({error: 'request must contain signed_s3_url'})

    const callback_url  = req.body.callback_url;
    const download_url  = req.body.download_url;
    const signed_s3_url = req.body.signed_s3_url;

    // by by Content-Type
    let ext;
    const downloadfile_res = syncrequest('HEAD', download_url);
    if (downloadfile_res.statusCode != 200){
        return downloadfile_res.status(422).send({error: 'could not get download_url meta data'});
    } else {
        if (!mimetypes[downloadfile_res.headers['content-type']].extensions[0]){
            return downloadfile_res.status(422).send({error: 'not supported content-type'});
        }
        ext = mimetypes[downloadfile_res.headers['content-type']].extensions[0];
        logger.info(ext);
    }

    let options = appConfig.options;
    if (req.body.options) {
        options = Object.assign({}, options, req.body.options);
    }
    // compute width-height ratio for "landscape" based on width
    if (options.orientation && options.orientation == "landscape") {
        options.height = Math.floor(options.width * (1 / Math.sqrt(2)));  // DIN A4
        options.keepAspect = false;
    }

    logger.info('---- Start new file preview request ----');
    logger.info(options);

    const job = filePreviewQueue.create('filePreview', {
        options: options,
        download_url: download_url,
        ext: ext,
        signed_s3_url, signed_s3_url
    });

    job.attempts(2).backoff(true).save();
    
    job.on('failed', function (err) {
        return responseError(err, callback_url);
    });
    
    job.on('complete', function (result) {
        logger.info(util.format('completed job, result: %s', result));
        return responseSuccess(result, callback_url);
    });

    res.json("OK");
});


function responseError(error, callback_url){
    logger.error(error);
    request.post({
        headers: {'content-type' : 'application/json'},
        url:     callback_url,
        body:    JSON.stringify({
            error: util.format('An error occured: %s', error)
        })
    
    }, function(error){
        if (error){
            logger.error(error);
        }
    });
}


function responseSuccess(previewUrl, callback_url){
    request.post({
        headers: {'content-type' : 'application/json'},
        url:     callback_url,
        body:    JSON.stringify({
            previewUrl: previewUrl
        })

    }, function(error){
        if (error) {
            return logger.error(error);
        }
        logger.info(previewUrl);
    });
}


function handleFilePreview(options, download_url, ext, signed_s3_url, done){
    logger.info('handleFilePreview called');

    const uploadFile = function(previewFileObj){
        logger.info('uploadFile called');
        fs.readFile(previewFileObj.name, function (error, data) {
            if (error) {
                logger.error(error);
                done(new Error(error));
            }
            logger.info('upload file to AWS');
            request.put({
                headers: {'content-type' : util.format('image/%s', options.outputFormat)},
                body: data,
                url: signed_s3_url

            }, function(error, response, body){
                logger.info('response.statusCode: ' + response.statusCode);

                previewFileObj.removeCallback();
                if (error) {
                    logger.error(error);
                    done(new Error(error));
                } else {
                    if (response.statusCode > 200) {
                        new xml2js.Parser().parseString(body, function (error, result) {
                            if (error) {
                                logger.error(error);
                                // AWS Error could not be parsed
                                done(new Error(error));
                            } else {
                                const error = util.format('%s (%s)', result.Error.Message, result.Error.Code);
                                logger.error(error);
                                done(new Error(error));
                            }
                        });
                    } else {
                        done(null, signed_s3_url.split('?')[0]);
                    }
                }
            });
        });
    }
    
    const downloadFileObj = tmp.fileSync({postfix: '.' + ext});
    logger.info('create temp download file: ' + downloadFileObj.name);

    const file = fs.createWriteStream(downloadFileObj.name);

    file.on('finish', function(){
        const previewFileObj = tmp.fileSync({postfix: '.' + options.outputFormat});
        logger.info('create temp preview file: ' + previewFileObj.name);
    
        filepreview.generateAsync(downloadFileObj.name, previewFileObj.name, options)
            .then(function(){
                downloadFileObj.removeCallback();
                if (signed_s3_url) {
                    return uploadFile(previewFileObj);
                }
            }).catch(function(error) {
                logger.error(error);
                done(new Error(error));
            });
    }).on('error', function(error){
        logger.error(error);
        done(new Error(error));
    });

    request(download_url)
        .on('error', function(error) {
            done(new Error(error));
        })
        .pipe(file);
}


app.listen(appConfig.port || 3000, function () {
    logger.info(util.format('Example app listening on port %s!', (appConfig.port || '3000')));
});
