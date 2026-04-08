require("dotenv").config();
const app = require("./src/app");
const logger = require("./src/utils/logger");

const PORT = process.env.PORT || 4545;

app.listen(PORT, () => {
  logger.info(`Scanning service running on port ${PORT}`);
  logger.info(`Documentation:  http://localhost:${PORT}/documentation`);
  logger.info(`Docs home:      http://localhost:${PORT}/`);
  logger.info(`Health check:   http://localhost:${PORT}/api/health`);
  logger.info(`Scan endpoint:  http://localhost:${PORT}/api/scan`);
});
