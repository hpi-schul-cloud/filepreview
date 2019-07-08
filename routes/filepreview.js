const config = require('config');

const options = require("./options")

const appConfig = config.get('app');
const createJob = require("../app/jobqueue");

module.exports = (fastify, _, next) => {
    fastify.post("/filepreview", options, async (req, res) => {
        const {callbackUrl, downloadUrl, signedS3Url, options} = req.body;

        const taskOptions = {
            ...appConfig.options,
            ...options
        };

        // compute width-height ratio for "landscape" based on width
        if (taskOptions.orientation == 'landscape') {
            taskOptions.height = Math.floor(taskOptions.width * (1 / Math.sqrt(2))); // DIN A4
            taskOptions.keepAspect = false;
        }

        createJob(taskOptions, downloadUrl, signedS3Url, callbackUrl);
        res.send("OK")
    })

    next();
}