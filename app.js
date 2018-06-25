const fs                = require('fs');

const bodyParser        = require('body-parser');
const config            = require('config');
const express           = require('express');
const filepreview       = require('filepreview-es6');
const kue               = require('kue');
const passport          = require('passport');
const Strategy          = require('passport-http').BasicStrategy;
const request           = require('request');
const tmp               = require('tmp');
const util              = require('util');
const winston           = require('winston');
const DailyRotateFile   = require('winston-daily-rotate-file');
const xml2js            = require('xml2js');


// get mimetype definitions from filepreview-es6 package
const mimetypes         = require('./node_modules/filepreview-es6/db.json');


// config definitions
const appConfig         = config.get('app');
const authUsers         = [appConfig.authUser];
const jobqueueConfig    = config.get('jobqueue');


// helper function for authentification
function findByUsername(username, callback) {
    process.nextTick(function() {
        for (var i = 0, len = authUsers.length; i < len; i++) {
            var record = authUsers[i];
            if (record.username === username) {
                return callback(null, record);
            }
        }
        return callback(null, null);
    });
};
// define BasicAuth as authentification strategy
passport.use(new Strategy(
    function(username, password, callback) {
        findByUsername(username, function(error, user) {
            if (error) { return callback(error); }
            if (!user) { return callback(null, false); }
            if (user.password != password) { return callback(null, false); }
            return callback(null, user);
        });
    }
));


// define logging handler, with file rotation
const logLevel = (process.env.NODE_ENV == 'production' ? "error" : "debug");
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


// define jobQueue handler
const filePreviewQueue = kue.createQueue(jobqueueConfig);
filePreviewQueue.process('filePreview', function (job, done) {
    logger.debug('processing job: ' + job.id);
    handleFilePreview(
        job.data.options,
        job.data.download_url,
        job.data.signed_s3_url,
        done
    );
});


// let's create the app
const app = express();
app.use(bodyParser.json())

app.listen(appConfig.port || 3000, function() {
    logger.info(util.format('Example app listening on port %s!', (appConfig.port || '3000')));
});

app.post('/filepreview', passport.authenticate('basic', { session: false }), function (req, res) {
    if (!req.body.callback_url) return res.status(422).send({error: 'request must contain callback_url'})
    if (!req.body.download_url) return res.status(422).send({error: 'request must contain download_url'})
    if (!req.body.signed_s3_url) return res.status(422).send({error: 'request must contain signed_s3_url'})

    const callback_url  = req.body.callback_url;
    const download_url  = req.body.download_url;
    const signed_s3_url = req.body.signed_s3_url;

    let options = appConfig.options;
    if (req.body.options) {
        options = Object.assign({}, options, req.body.options);
    }
    // compute width-height ratio for "landscape" based on width
    if (options.orientation && options.orientation == "landscape") {
        options.height = Math.floor(options.width * (1 / Math.sqrt(2)));  // DIN A4
        options.keepAspect = false;
    }

    createJob(options, download_url, signed_s3_url, callback_url);
    res.json("OK");
});


function createJob(options, download_url, signed_s3_url, callback_url){
    logger.info('---- Start new file preview job ----');
    logger.debug({
        options: options,
        download_url: download_url,
        signed_s3_url, signed_s3_url
    });

    const job = filePreviewQueue.create('filePreview', {
        options: options,
        download_url: download_url,
        signed_s3_url, signed_s3_url
    });

    job.attempts(2).backoff(true).save();

    job.on('failed', function (error) {
        logger.info(util.format('failed job, result: %s', error));
        return responseError(error, callback_url);
    });

    job.on('complete', function (result) {
        logger.info(util.format('completed job, result: %s', result));
        return responseSuccess(result, callback_url);
    });
}


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
        logger.debug(previewUrl);
    });
}


function handleFilePreview(options, download_url, signed_s3_url, done){
    logger.debug('handleFilePreview called');

    checkDownload(download_url, done, function(ext){
        downloadFile(options, download_url, ext, done, function(previewFileObj){
            uploadFile(previewFileObj, signed_s3_url, options, done);
        })
    });
};


function checkDownload(download_url, done, next){
    // get extension by by Content-Type
    request.head(download_url, {timeout: 10000}, function (error, response) {
        if (error || response.statusCode > 200) {
            return done(new Error('could not get download_url meta data'));
        }
        if (!mimetypes[response.headers['content-type']].extensions[0]){
            return done(new Error('not supported content-type'));
        }
        logger.debug(response.headers);
        const ext = mimetypes[response.headers['content-type']].extensions[0];
        next(ext);
    });
}


function downloadFile(options, download_url, ext, done, next){
    const downloadFileObj = tmp.fileSync({postfix: '.' + ext});
    logger.debug('create temp download file: ' + downloadFileObj.name);

    const file = fs.createWriteStream(downloadFileObj.name);
    file.on('finish', function(){
        const previewFileObj = tmp.fileSync({postfix: '.' + options.outputFormat});
        logger.debug('create temp preview file: ' + previewFileObj.name);

        filepreview.generateAsync(downloadFileObj.name, previewFileObj.name, options)
            .then(function(){
                downloadFileObj.removeCallback();
                next(previewFileObj);
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


function uploadFile(previewFileObj, signed_s3_url, options, done){
    logger.debug('uploadFile called');
    fs.readFile(previewFileObj.name, function (error, data) {
        if (error) {
            logger.error(error);
            done(new Error(error));
        }
        logger.debug('upload file to AWS');
        request.put({
            headers: {'content-type' : util.format('image/%s', options.outputFormat)},
            body: data,
            url: signed_s3_url

        }, function(error, response, body){
            logger.debug('response.statusCode: ' + response.statusCode);

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
};
