const express = require("express");
const { getAllCapabilities } = require("../services/capabilityService");
const logger = require("../utils/logger");

const router = express.Router();

/**
 * @openapi
 * /api/capabilities:
 *   get:
 *     tags: [Capabilities]
 *     summary: Check duplex printing + ADF scanning support
 *     description: Reports whether the currently-connected printer supports duplex (2-sided) printing (via `lpoptions -p <printer> -l`) and whether the currently-connected scanner has an ADF/feeder (via `scanimage --help -d <device>`), so a printer/scanner swap can be verified without shell access to the exam-center machine. This same check runs at service startup and gates POST /api/scan/auto/start. `null` values mean "couldn't be determined" (always the case on Windows, or if the check itself failed) rather than "unsupported". Cached for CAPABILITY_CACHE_MS.
 *     responses:
 *       200:
 *         description: Capability snapshot
 *         content:
 *           application/json:
 *             schema: { $ref: '#/components/schemas/CapabilitiesResponse' }
 *       500:
 *         description: Capability check failed unexpectedly
 *         content:
 *           application/json:
 *             schema: { $ref: '#/components/schemas/ErrorResponse' }
 */
router.get("/capabilities", async (req, res) => {
  try {
    const capabilities = await getAllCapabilities();
    res.json({ success: true, ...capabilities });
  } catch (err) {
    logger.error(`Capability check failed: ${err.message}`, { stack: err.stack });
    res.status(500).json({ success: false, message: err.message });
  }
});

module.exports = router;
