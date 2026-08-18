import { uploadService } from "../services/uploadService.js";
import { asyncHandler, AppError } from "../utils/errors.js";

export const uploadController = {
  // POST /upload/image  (single file, field name: "image")
  image: asyncHandler(async (req, res) => {
    if (!req.file) {
      throw new AppError("No image file uploaded (field name must be 'image')", 400);
    }

    const result = await uploadService.uploadImage(req.file, req.body.folder);

    res.status(201).json({ success: true, data: result });
  }),

  // POST /upload/images (multiple files, field name: "images")
  images: asyncHandler(async (req, res) => {
    if (!req.files || req.files.length === 0) {
      throw new AppError("No image files uploaded (field name must be 'images')", 400);
    }

    const result = await uploadService.uploadImages(req.files, req.body.folder);

    res.status(201).json({ success: true, data: result });
  }),

  // DELETE /upload/image  { publicId }
  removeImage: asyncHandler(async (req, res) => {
    const { publicId } = req.body;

    const result = await uploadService.removeImage(publicId);

    res.json({ success: true, data: result });
  })
};