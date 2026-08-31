import { del, list } from "@vercel/blob";

const prefix = process.argv[2] || "rooms/";
let cursor;
let deleted = 0;

if (!process.env.BLOB_READ_WRITE_TOKEN) {
  console.error("Missing BLOB_READ_WRITE_TOKEN.");
  console.error("Run this where the Vercel Blob env vars are available, or set the token locally first.");
  process.exit(1);
}

do {
  const page = await list({ prefix, cursor, limit: 1000 });
  const urls = page.blobs.map((blob) => blob.url);

  if (urls.length > 0) {
    await del(urls);
    deleted += urls.length;
    console.log(`Deleted ${urls.length} blob(s)...`);
  }

  cursor = page.cursor;
} while (cursor);

console.log(`Done. Deleted ${deleted} blob(s) from prefix "${prefix}".`);
