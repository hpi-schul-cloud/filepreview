const fs = require('fs');

const bodyParser = require('body-parser');
const config = require('config');
const express = require('express');
const filepreview = require('filepreview-es6');
const kue = require('kue');
const request = require('request');
const tmp = require('tmp');
const util = require('util');
const winston = require('winston');
const DailyRotateFile = require('winston-daily-rotate-file');
const xml2js = require('xml2js');
// config definitions
const appConfig = config.get('app');
const jobqueueConfig = config.get('jobqueue');

// define logging handler, with file rotation
const logLevel = process.env.NODE_ENV == 'production' ? 'error' : 'debug';
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
filePreviewQueue.process('filePreview', function(job, done) {
    logger.debug('processing job: ' + job.id);
    handleFilePreview(
        job.data.options,
        job.data.downloadUrl,
        job.data.signedS3Url,
        done
    );
});

// let's create the app
const app = express();
app.use(bodyParser.json());

app.listen(appConfig.port || 3000, function() {
    logger.info(
        util.format(
            'Example app listening on port %s!',
            appConfig.port || '3000'
        )
    );
});

app.post(
    '/filepreview',
    //passport.authenticate('basic', { session: false }),
    function(req, res) {
        if (!req.body.callbackUrl)
            return res
                .status(422)
                .send({ error: 'request must contain callbackUrl' });
        if (!req.body.downloadUrl)
            return res
                .status(422)
                .send({ error: 'request must contain downloadUrl' });
        if (!req.body.signedS3Url)
            return res
                .status(422)
                .send({ error: 'request must contain signedS3Url' });

        const callbackUrl = req.body.callbackUrl;
        const downloadUrl = req.body.downloadUrl;
        const signedS3Url = req.body.signedS3Url;

        let options = appConfig.options;
        if (req.body.options) {
            options = Object.assign({}, options, req.body.options);
        }
        // compute width-height ratio for "landscape" based on width
        if (options.orientation && options.orientation == 'landscape') {
            options.height = Math.floor(options.width * (1 / Math.sqrt(2))); // DIN A4
            options.keepAspect = false;
        }

        createJob(options, downloadUrl, signedS3Url, callbackUrl);
        res.json('OK');
    }
);

function createJob(options, downloadUrl, signedS3Url, callbackUrl) {
    logger.info('---- Start new file preview job ----');
    logger.debug({ options, downloadUrl, signedS3Url, callbackUrl });

    const job = filePreviewQueue.create('filePreview', {
        options,
        downloadUrl,
        signedS3Url,
        callbackUrl
    });

    job.attempts(2)
        .backoff(true)
        .save();

    job.on('failed', function(error) {
        logger.info(util.format('failed job, result: %s', error));
        return responseError(error, callbackUrl);
    });

    job.on('complete', function(result) {
        logger.info(util.format('completed job, result: %s', result));
        return responseSuccess(result, callbackUrl);
    });
}

function responseError(error, callbackUrl) {
    logger.error(error);
    request.post(
        {
            headers: { 'content-type': 'application/json' },
            url: callbackUrl,
            body: JSON.stringify({
                error: util.format('An error occured: %s', error)
            })
        },
        function(error) {
            if (error) {
                logger.error(error);
            }
        }
    );
}

function responseSuccess(previewUrl, callbackUrl) {
    request.patch(
        {
            headers: {
                'content-type': 'application/json'
            },
            url: callbackUrl,
            body: JSON.stringify({
                thumbnail: previewUrl
            })
        },
        function(error) {
            if (error) {
                return logger.error(error);
            }
            logger.debug(previewUrl);
        }
    );
}

function handleFilePreview(options, downloadUrl, signedS3Url, done) {
    logger.debug('handleFilePreview called');

    downloadFile(options, downloadUrl, done, function(previewFileObj) {
        uploadFile(previewFileObj, signedS3Url, options, done);
    });
}

function downloadFile(options, downloadUrl, done, next) {
    const ext = downloadUrl.split('.').pop();
    const downloadFileObj = tmp.fileSync({ postfix: '.' + ext });
    logger.debug('create temp download file: ' + downloadFileObj.name);

    const file = fs.createWriteStream(downloadFileObj.name);
    file.on('finish', function() {
        const previewFileObj = tmp.fileSync({
            postfix: '.' + options.outputFormat
        });
        logger.debug('create temp preview file: ' + previewFileObj.name);

        filepreview
            .generateAsync(downloadFileObj.name, previewFileObj.name, options)
            .then(function() {
                downloadFileObj.removeCallback();
                next(previewFileObj);
            })
            .catch(function(error) {
                logger.error(error);
                done(new Error(error));
            });
    }).on('error', function(error) {
        logger.error(error);
        done(new Error(error));
    });

    request(downloadUrl)
        .on('error', function(error) {
            done(new Error(error));
        })
        .pipe(file);
}

function uploadFile(previewFileObj, signedS3Url, options, done) {
    logger.debug('uploadFile called');
    fs.readFile(previewFileObj.name, function(error, data) {
        if (error) {
            logger.error(error);
            done(new Error(error));
        }
        logger.debug('upload file to AWS');
        request.put(
            {
                headers: {
                    'content-type': util.format(
                        'image/%s',
                        options.outputFormat
                    )
                },
                body: data,
                url: signedS3Url
            },
            function(error, response, body) {
                previewFileObj.removeCallback();
                if (error) {
                    logger.error(error);
                    done(new Error(error));
                } else {
                    if (response.statusCode > 200) {
                        new xml2js.Parser().parseString(body, function(
                            error,
                            result
                        ) {
                            if (error) {
                                logger.error(error);
                                // AWS Error could not be parsed
                                done(new Error(error));
                            } else {
                                const error = util.format(
                                    '%s (%s)',
                                    result.Error.Message,
                                    result.Error.Code
                                );
                                logger.error(error);
                                done(new Error(error));
                            }
                        });
                    } else {
                        done(null, signedS3Url.split('?')[0]);
                    }
                }
            }
        );
    });
}
