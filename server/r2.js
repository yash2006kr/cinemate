import { DeleteObjectCommand, PutObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";

const uploadExpirySeconds = 60 * 60;

export function hasR2Config() {
  return Boolean(
    process.env.R2_ACCOUNT_ID &&
    process.env.R2_ACCESS_KEY_ID &&
    process.env.R2_SECRET_ACCESS_KEY &&
    process.env.R2_BUCKET &&
    process.env.R2_PUBLIC_URL
  );
}

function r2Client() {
  return new S3Client({
    region: "auto",
    endpoint: `https://${process.env.R2_ACCOUNT_ID}.r2.cloudflarestorage.com`,
    credentials: {
      accessKeyId: process.env.R2_ACCESS_KEY_ID,
      secretAccessKey: process.env.R2_SECRET_ACCESS_KEY
    }
  });
}

export function publicR2Url(key) {
  return `${process.env.R2_PUBLIC_URL.replace(/\/$/, "")}/${key}`;
}

export async function createR2Upload({ key, contentType }) {
  const command = new PutObjectCommand({
    Bucket: process.env.R2_BUCKET,
    Key: key,
    ContentType: contentType || "application/octet-stream"
  });

  return {
    uploadUrl: await getSignedUrl(r2Client(), command, { expiresIn: uploadExpirySeconds }),
    mediaUrl: publicR2Url(key),
    key
  };
}

export async function deleteR2Object(key) {
  if (!hasR2Config() || !key) return;
  await r2Client().send(new DeleteObjectCommand({
    Bucket: process.env.R2_BUCKET,
    Key: key
  }));
}
