const fastify = require("fastify")
const config = require('config');

const appConfig = config.get('app');
const logger = require("./logger")

const filePreview = require("./routes/filepreview")

const app = fastify();
app.register(filePreview)

app.listen(appConfig.port || 3000, "0.0.0.0", function(err, address) {
    if (err) throw err
    logger.info(`server listening on ${address}`)
});
