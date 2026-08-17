/**
 * Reusable OpenAPI component schemas — the Express/plain-JS equivalent of the
 * NestJS services' dedicated `*.swagger.dto.ts` response/request classes.
 * Referenced from route JSDoc blocks via `$ref: '#/components/schemas/<Name>'`.
 */

const ErrorResponse = {
  type: "object",
  properties: {
    success: { type: "boolean", example: false },
    message: { type: "string", example: "Something went wrong" },
  },
  required: ["success", "message"],
};

const HealthResponse = {
  type: "object",
  properties: {
    success: { type: "boolean", example: true },
    status: { type: "string", example: "ok" },
    service: { type: "string", example: "Print Scanning Local Service" },
    platform: { type: "string", example: "linux" },
    port: { type: "integer", example: 4545 },
    timestamp: { type: "string", format: "date-time" },
    capabilities: { type: "array", items: { type: "string" }, example: ["scan", "print"] },
  },
};

const ScanResult = {
  type: "object",
  properties: {
    success: { type: "boolean", example: true },
    filename: { type: "string", example: "ROLL123_MATH2026_2026-04-01T07-38-46.pdf" },
    filePath: { type: "string" },
    platform: { type: "string", example: "linux" },
    device: { type: "string", nullable: true, example: "airscan:e2:Canon GX4000 series" },
    scansDirectory: { type: "string" },
    message: { type: "string" },
  },
};

const ScanSessionStartResponse = {
  type: "object",
  properties: {
    success: { type: "boolean", example: true },
    sessionId: { type: "string" },
    totalPages: { type: "integer", example: 10 },
    message: { type: "string" },
  },
};

const ScanPageProgressResponse = {
  type: "object",
  properties: {
    success: { type: "boolean", example: true },
    sessionId: { type: "string" },
    currentPage: { type: "integer", example: 2 },
    totalPages: { type: "integer", example: 10 },
    remaining: { type: "integer", example: 8 },
    message: { type: "string" },
  },
};

const ScanCompleteResponse = {
  type: "object",
  properties: {
    success: { type: "boolean", example: true },
    filename: { type: "string" },
    filePath: { type: "string" },
    platform: { type: "string" },
    device: { type: "string", nullable: true },
    scansDirectory: { type: "string" },
    totalPages: { type: "integer" },
    message: { type: "string" },
  },
};

const CancelSessionResponse = {
  type: "object",
  properties: {
    success: { type: "boolean", example: true },
    message: { type: "string" },
  },
};

const AutoScanStartResponse = {
  type: "object",
  properties: {
    success: { type: "boolean", example: true },
    jobId: { type: "string", example: "a1b2c3d4e5f6" },
    totalPages: { type: "integer", example: 50 },
    estimatedSeconds: { type: "integer", example: 750 },
    message: { type: "string" },
  },
};

const AutoScanFile = {
  type: "object",
  properties: {
    page: { type: "integer", nullable: true, description: "Only present for outputMode \"separate\"" },
    filename: { type: "string" },
    filePath: { type: "string" },
  },
};

const AutoScanJobResponse = {
  type: "object",
  properties: {
    success: { type: "boolean", example: true },
    jobId: { type: "string" },
    status: { type: "string", enum: ["scanning", "completed", "failed", "cancelled"] },
    mode: { type: "string", enum: ["separate", "merged"] },
    totalPages: { type: "integer" },
    scannedCount: { type: "integer" },
    files: { type: "array", items: AutoScanFile },
    warning: { type: "string", nullable: true },
    error: { type: "string", nullable: true },
    message: { type: "string", nullable: true },
    scansDirectory: { type: "string" },
  },
};

const ExamFolderListResponse = {
  type: "object",
  properties: {
    success: { type: "boolean", example: true },
    exams: {
      type: "array",
      items: {
        type: "object",
        properties: {
          examCode: { type: "string", example: "MATH2026" },
          fileCount: { type: "integer", example: 12 },
        },
      },
    },
  },
};

const ExamDocumentEntry = {
  type: "object",
  properties: {
    filename: { type: "string" },
    size: { type: "integer", description: "Bytes" },
    createdAt: { type: "string", format: "date-time" },
    previewUrl: { type: "string" },
  },
};

const ExamDocumentListResponse = {
  type: "object",
  properties: {
    success: { type: "boolean", example: true },
    examCode: { type: "string" },
    documentCount: { type: "integer" },
    documents: { type: "array", items: ExamDocumentEntry },
  },
};

const DeleteDocsResponse = {
  type: "object",
  properties: {
    success: { type: "boolean", example: true },
    deleted: { type: "array", items: { type: "string" } },
    notFound: { type: "array", items: { type: "string" } },
    errors: { type: "array", items: { type: "string" } },
    message: { type: "string" },
  },
};

const PrintersResponse = {
  type: "object",
  properties: {
    success: { type: "boolean", example: true },
    printers: { type: "array", items: { type: "string" }, example: ["Canon_GX4000_series_USB"] },
    default: { type: "string", example: "Canon_GX4000_series_USB" },
  },
};

const PrintResponse = {
  type: "object",
  properties: {
    success: { type: "boolean", example: true },
    message: { type: "string", example: "Print job queued successfully" },
    jobId: { type: "string" },
    warning: {
      type: "string",
      nullable: true,
      description: "Present only when duplex was requested but the printer doesn't support it — the job was printed single-sided instead.",
      example: "Printer \"Canon_GX4000_series_USB\" doesn't support duplex — printed single-sided instead.",
    },
  },
};

const CapabilitiesResponse = {
  type: "object",
  properties: {
    success: { type: "boolean", example: true },
    printer: {
      type: "object",
      properties: {
        name: { type: "string", nullable: true, example: "Canon_GX4000_series_USB" },
        duplexSupported: { type: "boolean", nullable: true, description: "null on Windows (unchecked)" },
        sidesOptions: { type: "array", items: { type: "string" }, example: ["one-sided", "two-sided-long-edge", "two-sided-short-edge"], description: "Raw values reported by the driver, under whichever option name it uses (see duplexOptionName)." },
        duplexOptionName: { type: "string", nullable: true, enum: ["sides", "Duplex", null], description: "Which CUPS option name this printer's driver actually uses. Some PPDs (e.g. this project's own Canon MAXIFY GX4070) only expose the older 'Duplex' keyword (None/DuplexNoTumble/DuplexTumble), not the IPP-standard 'sides'." },
      },
    },
    scanner: {
      type: "object",
      properties: {
        device: { type: "string", nullable: true, example: "airscan:e2:Canon GX4000 series" },
        adfSupported: { type: "boolean", nullable: true, description: "null on Windows, or if the check itself couldn't complete" },
        sources: { type: "array", items: { type: "string" }, example: ["Flatbed", "ADF"] },
      },
    },
  },
};

module.exports = {
  ErrorResponse,
  HealthResponse,
  ScanResult,
  ScanSessionStartResponse,
  ScanPageProgressResponse,
  ScanCompleteResponse,
  CancelSessionResponse,
  AutoScanStartResponse,
  AutoScanFile,
  AutoScanJobResponse,
  ExamFolderListResponse,
  ExamDocumentEntry,
  ExamDocumentListResponse,
  DeleteDocsResponse,
  PrintersResponse,
  PrintResponse,
  CapabilitiesResponse,
};
