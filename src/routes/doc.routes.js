const express = require("express");
const fs = require("fs");
const path = require("path");
const { marked } = require("marked");

const router = express.Router();

const README_PATH  = path.join(__dirname, "../../README.md");
const TEMPLATE_PATH = path.join(__dirname, "../templates/doc.html");

// Custom renderer: adds anchor IDs to headings for sidebar nav
const renderer = new marked.Renderer();
renderer.heading = function ({ text, depth }) {
  const slug = text
    .toLowerCase()
    .replace(/[^\w\s-]/g, "")
    .replace(/\s+/g, "-")
    .replace(/-+/g, "-")
    .trim();
  return `<h${depth} id="${slug}">${text}</h${depth}>\n`;
};
marked.setOptions({ renderer });

/**
 * Build sidebar nav links from README headings.
 * Only picks h2 and h3 to keep the sidebar concise.
 */
function buildNavItems(markdown) {
  const lines = markdown.split("\n");
  const items = [];
  for (const line of lines) {
    const h2 = line.match(/^## (.+)/);
    const h3 = line.match(/^### (.+)/);
    if (h2) {
      const text = h2[1].trim();
      const slug = text.toLowerCase().replace(/[^\w\s-]/g, "").replace(/\s+/g, "-").replace(/-+/g, "-").trim();
      items.push({ text, slug, level: 2 });
    } else if (h3) {
      const text = h3[1].trim();
      const slug = text.toLowerCase().replace(/[^\w\s-]/g, "").replace(/\s+/g, "-").replace(/-+/g, "-").trim();
      items.push({ text, slug, level: 3 });
    }
  }
  return items;
}

function buildSidebarHtml(items) {
  return items
    .map((item) => {
      const indent = item.level === 3 ? ' class="sub"' : "";
      return `<li${indent}><a href="#${item.slug}">${item.text}</a></li>`;
    })
    .join("\n");
}

/**
 * GET /doc
 * Renders README.md as a styled documentation page.
 */
router.get("/doc", (req, res) => {
  let markdown;
  try {
    markdown = fs.readFileSync(README_PATH, "utf-8");
  } catch {
    return res.status(500).send("<h1>README.md not found</h1>");
  }

  const contentHtml = marked.parse(markdown);
  const navItems = buildNavItems(markdown);
  const sidebarHtml = buildSidebarHtml(navItems);

  let template;
  try {
    template = fs.readFileSync(TEMPLATE_PATH, "utf-8");
  } catch {
    return res.status(500).send("<h1>doc.html template not found</h1>");
  }

  const html = template
    .replace("{{sidebarHtml}}", sidebarHtml)
    .replace("{{contentHtml}}", contentHtml);

  res.setHeader("Content-Type", "text/html; charset=utf-8");
  res.send(html);
});

module.exports = router;
