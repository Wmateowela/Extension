export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
  res.setHeader("Content-Type", "text/css; charset=utf-8");
  res.setHeader("Cache-Control", "no-store, no-cache, must-revalidate");

  if (req.method === "OPTIONS") {
    return res.status(200).end();
  }

  // Live dynamic CSS hosted strictly on Vercel Backend
  const css = `
    /* Remote Injected UI Styles for Roblox */
    .nmc-verified-badge {
      display: inline-flex !important;
      align-items: center !important;
      margin-left: 6px !important;
      vertical-align: middle !important;
    }
    .nmc-injected-card {
      transition: all 0.2s ease-in-out !important;
    }
  `;

  return res.status(200).send(css);
}
