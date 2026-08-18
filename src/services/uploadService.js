import cloudinary from "../config/cloudinary.js";
import { AppError } from "../utils/errors.js";


const streamUpload = (buffer, folder) => {

  return new Promise((resolve, reject) => {

    const stream =
      cloudinary.uploader.upload_stream(
        {
          folder,
          resource_type: "image",
        },

        (error, result) => {

          if (error) {

            console.error(
              "❌ CLOUDINARY UPLOAD ERROR:"
            );

            console.error(error);

            return reject(error);
          }

          console.log(
            "✅ CLOUDINARY UPLOAD SUCCESS:",
            result.public_id
          );

          resolve(result);

        }
      );


    stream.end(buffer);

  });

};


const shapeImageResult = (result) => {

  const original =
    result.secure_url;


  return {

    full:
      original.replace(
        "/upload/",
        "/upload/q_auto,f_auto,w_900/"
      ),

    thumb:
      original.replace(
        "/upload/",
        "/upload/q_auto,f_auto,w_300/"
      ),

    small:
      original.replace(
        "/upload/",
        "/upload/q_auto,f_auto,w_100/"
      ),

    original,

    public_id:
      result.public_id,

    format:
      result.format,

    bytes:
      result.bytes,

  };

};


export const uploadService = {


  /*
  |--------------------------------------------------------------------------
  | SINGLE IMAGE
  |--------------------------------------------------------------------------
  */

  async uploadImage(
    file,
    folder = "biashnet"
  ) {

    if (!file) {

      throw new AppError(
        "No file provided",
        400
      );

    }


    console.log(
      "📤 Uploading image:",
      {
        originalname: file.originalname,
        mimetype: file.mimetype,
        size: file.size,
        folder,
      }
    );


    const result =
      await streamUpload(
        file.buffer,
        folder
      );


    return shapeImageResult(result);

  },


  /*
  |--------------------------------------------------------------------------
  | MULTIPLE IMAGES
  |--------------------------------------------------------------------------
  */

  async uploadImages(
    files,
    folder = "biashnet"
  ) {

    if (
      !files ||
      files.length === 0
    ) {

      throw new AppError(
        "No files provided",
        400
      );

    }


    console.log(
      `📤 Uploading ${files.length} image(s)...`
    );


    const uploads =
      await Promise.allSettled(

        files.map(
          (file) =>
            this.uploadImage(
              file,
              folder
            )
        )

      );


    /*
    |--------------------------------------------------------------------------
    | Successful uploads
    |--------------------------------------------------------------------------
    */

    const succeeded =
      uploads

        .filter(
          (result) =>
            result.status ===
            "fulfilled"
        )

        .map(
          (result) =>
            result.value
        );


    /*
    |--------------------------------------------------------------------------
    | Failed uploads
    |--------------------------------------------------------------------------
    */

    const failed =
      uploads

        .filter(
          (result) =>
            result.status ===
            "rejected"
        );


    const failedCount =
      failed.length;


    /*
    |--------------------------------------------------------------------------
    | Print actual errors
    |--------------------------------------------------------------------------
    */

    if (failed.length > 0) {

      console.error(
        "\n❌ FAILED CLOUDINARY UPLOADS:"
      );


      failed.forEach(
        (failure, index) => {

          console.error(
            `\nImage ${index + 1}:`
          );

          console.error(
            failure.reason
          );

        }
      );

    }


    /*
    |--------------------------------------------------------------------------
    | All failed
    |--------------------------------------------------------------------------
    */

    if (succeeded.length === 0) {

      throw new AppError(
        "All image uploads failed",
        502
      );

    }


    /*
    |--------------------------------------------------------------------------
    | Some succeeded
    |--------------------------------------------------------------------------
    */

    if (failedCount > 0) {

      console.warn(
        `⚠️ ${failedCount} image(s) failed.`
      );

    }


    return {

      images:
        succeeded,

      failedCount,

    };

  },


  /*
  |--------------------------------------------------------------------------
  | DELETE IMAGE
  |--------------------------------------------------------------------------
  */

  async removeImage(
    publicId
  ) {

    if (!publicId) {

      throw new AppError(
        "publicId is required",
        400
      );

    }


    const result =
      await cloudinary.uploader.destroy(
        publicId
      );


    if (
      result.result !== "ok" &&
      result.result !== "not found"
    ) {

      throw new AppError(
        "Failed to delete image",
        502
      );

    }


    return result;

  },

};