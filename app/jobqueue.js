const fs = require("fs")
const path = require("path")
const { promisify, format } = require("util")

const kue = require('kue');
const config = require('config');
const axios = require("axios")
const xml2js = require('xml2js');
const filepreview = require('filepreview-es6');
const { file } = require("tmp-promise")

const logger = require("../logger")
const jobqueueConfig = config.get('jobqueue');
const readFile = promisify(fs.readFile)

const filePreviewQueue = kue.createQueue(jobqueueConfig);
filePreviewQueue.process('filePreview', async function({
    id,
    data
}, done) {
    logger.debug(`processing job: ${id}`);

    let signedUrl; 
    try {
        const previewFileObj = await downloadFile(data.options, data.downloadUrl)
        signedUrl = await uploadFile(previewFileObj, data.signedS3Url, data.options);
    } catch(e) {
        logger.error(e);
        done(new Error(e));
    }

    return done(null, signedUrl);
});

async function downloadFile(options, downloadUrl) {
    const ext = path.extname(downloadUrl);
    const downloadFileObj = await file({ postfix: ext });

    logger.debug('create temp download file: ' + downloadFileObj.path);

    const tempFile = fs.createWriteStream(downloadFileObj.path);

    const {data} = await axios.get(downloadUrl, {responseType: "stream"})
    data.pipe(tempFile)

    return new Promise((resolve) => {
        tempFile.on('finish', async function() {
            const previewFileObj = await file({ postfix: `.${options.outputFormat}`});
            logger.debug('create temp preview file: ' + previewFileObj.path);
    
            await filepreview
                .generateAsync(downloadFileObj.path, previewFileObj.path, options)
            
            downloadFileObj.cleanup();
            resolve(previewFileObj);
        })
    })
}

async function uploadFile(previewFileObj, signedS3Url, options) {
    logger.debug('uploadFile called');

    const data = await readFile(previewFileObj.path)

    logger.debug('upload file to AWS');

    try {
        await axios({
            method: "put",
            url: signedS3Url,
            data,
            headers: {
                'content-type': format(
                    'image/%s',
                    options.outputFormat
                )
            }
        })
    } catch(e) {

        new xml2js.Parser().parseString(body, function(
            _,
            result
        ) {
            throw new Error(result)
        });
    }

    previewFileObj.cleanup();

    return signedS3Url.split('?')[0];
}


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
        logger.error(format('failed job, result: %s', error));

        axios.post(callbackUrl, {
            error
        }).catch(e => logger.error(e))
    });

    job.on('complete', function(thumbnail) {
        logger.info(format('completed job, result: %s', thumbnail));

        axios.patch(callbackUrl, {thumbnail}).catch(e => logger.error(e))
    });
}

module.exports = createJob