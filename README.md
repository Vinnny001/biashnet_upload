# Biashnet Upload Server

A standalone microservice that does **one job only**: accept image uploads and push them to Cloudinary. Your main Biashnet API (products, auth, etc.) calls this service instead of hitting Cloudinary directly.

## Setup

```bash
cp .env.example .env
# fill in CLOUDINARY_API_KEY / CLOUDINARY_API_SECRET from cloudinary.com dashboard
npm install
npm run dev   # or: npm start
```

## Endpoints

All routes are prefixed with `/upload` and (if `UPLOAD_API_KEY` is set) require header:
`x-api-key: <your key>`

| Method | Path            | Body                                      | Notes                          |
|--------|-----------------|--------------------------------------------|---------------------------------|
| POST   | /upload/image   | multipart/form-data, field `image`         | single image, optional `folder` field |
| POST   | /upload/images  | multipart/form-data, field `images` (x6)   | multiple images at once        |
| DELETE | /upload/image   | JSON `{ "publicId": "..." }`               | deletes from Cloudinary        |
| GET    | /health         | –                                          | health check                   |

## Response shape

Matches the image object shape your `ProductForm.js` already expects:

```json
{
  "success": true,
  "data": {
    "full": ".../upload/q_auto,f_auto,w_900/xyz.jpg",
    "thumb": ".../upload/q_auto,f_auto,w_300/xyz.jpg",
    "small": ".../upload/q_auto,f_auto,w_100/xyz.jpg",
    "original": ".../upload/xyz.jpg",
    "public_id": "xyz",
    "format": "jpg",
    "bytes": 123456
  }
}
```

## Why this design

- **Uses the Cloudinary Node SDK with signed server-side uploads** (via your `CLOUDINARY_API_SECRET`) instead of the unsigned upload-preset approach your frontend `cloudinaryUpload.js` currently uses. This is more secure and works from your backend — no secret ever touches the browser.
- **Multer with memory storage** — files are streamed straight to Cloudinary, never written to disk.
- **`apiKeyAuth` middleware** — prevents strangers from hammering your Cloudinary quota; your main Biashnet backend sends the shared key on every request.
- **Rate limiting + file-type/size limits** (8MB, jpeg/png/webp/gif only, max 6 files per batch) baked in.

## Wiring it into your existing Biashnet backend

Instead of your frontend calling Cloudinary directly, your main backend's `uploadService.js` would call this server:

```js
// in your main Biashnet backend
const res = await fetch(`${UPLOAD_SERVICE_URL}/upload/image`, {
  method: "POST",
  headers: { "x-api-key": process.env.UPLOAD_API_KEY },
  body: formData // FormData with field "image"
});
```

This keeps upload/Cloudinary concerns fully isolated from your product/auth logic — you can scale, redeploy, or swap storage providers for this service without touching the rest of Biashnet.
