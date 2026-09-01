export default async function handler(request, response) {
  if (request.method !== "GET") {
    response.setHeader("Allow", "GET");
    response.status(405).json({ error: "Method not allowed" });
    return;
  }

  const required = [
    "R2_ACCOUNT_ID",
    "R2_ACCESS_KEY_ID",
    "R2_SECRET_ACCESS_KEY",
    "R2_BUCKET",
    "R2_PUBLIC_URL"
  ];

  const missing = required.filter((key) => !process.env[key]);
  response.status(missing.length ? 500 : 200).json({
    ok: missing.length === 0,
    missing,
    bucket: process.env.R2_BUCKET || null,
    publicUrlConfigured: Boolean(process.env.R2_PUBLIC_URL)
  });
}
