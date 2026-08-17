const path = require("path");
const swaggerJsdoc = require("swagger-jsdoc");
const swaggerUi = require("swagger-ui-express");
const logger = require("../utils/logger");
const schemas = require("./schemas");
const { version } = require("../../package.json");

/**
 * Ported verbatim from module_backend/packages/core/src/swagger/swagger.config.ts
 * (the shared helper every NestJS service in this monorepo gates its Swagger
 * setup on) — kept local since this is a standalone service, not a monorepo
 * workspace member. Explicit SWAGGER_ENABLED wins; otherwise enabled whenever
 * NODE_ENV !== "production". This service never sets NODE_ENV, so it's
 * enabled by default without any extra configuration.
 */
function isSwaggerEnabled(nodeEnv, swaggerEnabled) {
  if (swaggerEnabled === "true") return true;
  if (swaggerEnabled === "false") return false;
  return nodeEnv !== "production";
}

/**
 * Ported verbatim from the same file — injects an "Export JSON" button into
 * the Swagger UI topbar that fetches `<current-path>-json`. Reused as-is
 * because /api-docs-json (below) follows that exact `-json` suffix convention.
 */
const swaggerExportButtonJs = `
  (function () {
    function injectButton() {
      const topbar = document.querySelector('.topbar-wrapper');
      if (!topbar || document.getElementById('swagger-export-btn')) return;
      const btn = document.createElement('button');
      btn.id = 'swagger-export-btn';
      btn.textContent = 'Export JSON';
      btn.style.cssText = [
        'margin-left:12px',
        'padding:6px 14px',
        'background:#49cc90',
        'color:#fff',
        'border:none',
        'border-radius:4px',
        'cursor:pointer',
        'font-size:13px',
        'font-weight:600',
        'font-family:sans-serif',
      ].join(';');
      btn.onmouseover = function () { btn.style.background = '#3aaf7a'; };
      btn.onmouseout  = function () { btn.style.background = '#49cc90'; };
      btn.onclick = function () {
        const jsonUrl = window.location.pathname.replace(/\\/$/, '') + '-json';
        fetch(jsonUrl)
          .then(function (r) { return r.json(); })
          .then(function (data) {
            const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
            const url  = URL.createObjectURL(blob);
            const a    = document.createElement('a');
            a.href     = url;
            a.download = 'api-spec.json';
            document.body.appendChild(a);
            a.click();
            document.body.removeChild(a);
            URL.revokeObjectURL(url);
          });
      };
      topbar.appendChild(btn);
    }
    const observer = new MutationObserver(injectButton);
    observer.observe(document.body, { childList: true, subtree: true });
    window.addEventListener('load', injectButton);
    injectButton();
  })();
`;

function buildSwaggerSpec() {
  const port = process.env.PORT || 4545;

  return swaggerJsdoc({
    definition: {
      openapi: "3.0.0",
      info: {
        title: "Print Scanning — Local Service API",
        description:
          "Local scanning/printing service for exam question papers and OMR answer sheets — SANE/NAPS2 scanning (single-page, session-based multi-page, automatic ADF batch), silent Puppeteer+CUPS/pdf-to-printer printing (including duplex), scanned-document management, and device capability checks. Runs on the exam-center machine attached to the physical scanner/printer — no authentication (local network use only).",
        version,
      },
      servers: [{ url: `http://localhost:${port}`, description: "Local service" }],
      tags: [
        { name: "Health" },
        { name: "Scanning" },
        { name: "Scan Sessions" },
        { name: "Auto Scan (ADF)" },
        { name: "Documents" },
        { name: "Printing" },
        { name: "Capabilities" },
      ],
      components: { schemas },
    },
    apis: [path.join(__dirname, "../routes/*.routes.js")],
  });
}

/**
 * Mounts Swagger UI at /api-docs (not the NestJS convention's /docs — that
 * path is already taken here by the human README doc page at "/" and
 * "/documentation", and /api/docs is a real JSON API for scanned exam
 * folders). Raw spec is served at /api-docs-json so swaggerExportButtonJs
 * above works unmodified.
 */
function mountSwagger(app) {
  if (!isSwaggerEnabled(process.env.NODE_ENV, process.env.SWAGGER_ENABLED)) {
    logger.info("Swagger UI disabled (SWAGGER_ENABLED=false)");
    return;
  }

  const spec = buildSwaggerSpec();

  app.get("/api-docs-json", (req, res) => res.json(spec));
  app.use(
    "/api-docs",
    swaggerUi.serve,
    swaggerUi.setup(spec, {
      customSiteTitle: "Print Scanning — API Docs",
      customJsStr: swaggerExportButtonJs,
    })
  );
}

module.exports = { isSwaggerEnabled, swaggerExportButtonJs, buildSwaggerSpec, mountSwagger };
