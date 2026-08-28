import { handleUpload } from "@vercel/blob/client";

export default async function handler(request, response) {
  if (request.method !== "POST") {
    response.setHeader("Allow", "POST");
    response.status(405).json({ error: "Method not allowed" });
    return;
  }

  try {
    const jsonResponse = await handleUpload({
      body: request.body,
      request,
      onBeforeGenerateToken: async (pathname, clientPayload) => ({
        allowedContentTypes: [
          "video/mp4",
          "video/webm",
          "video/ogg",
          "video/quicktime",
          "video/x-matroska",
          "application/octet-stream"
        ],
        maximumSizeInBytes: 8 * 1024 * 1024 * 1024,
        tokenPayload: clientPayload || pathname
      }),
      onUploadCompleted: async () => {}
    });

    response.status(200).json(jsonResponse);
  } catch (error) {
    response.status(400).json({ error: error.message });
  }
}
