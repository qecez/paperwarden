import { scanPixels } from "../encoding/qr";
import { friendly } from "../crypto/errors";

/** All acquired tracks belong to one generation, including delayed permission replies. */
export function cameraScanner(
  video: HTMLVideoElement,
  onFound: (bytes: Uint8Array) => void,
  onError: (message: string) => void,
) {
  let generation = 0;
  let frame = 0;
  let stream: MediaStream | undefined;
  let canvas: HTMLCanvasElement | undefined;

  function stop() {
    generation++;
    cancelAnimationFrame(frame);
    stream?.getTracks().forEach((track) => track.stop());
    stream = undefined;
    video.pause();
    video.srcObject = null;
    if (canvas) canvas.width = canvas.height = 0;
    canvas = undefined;
  }

  async function start() {
    stop();
    const current = generation;
    try {
      if (!navigator.mediaDevices?.getUserMedia) throw new Error("unavailable");
      const acquired = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: { ideal: "environment" }, width: { ideal: 1920 } },
        audio: false,
      });
      if (current !== generation) {
        acquired.getTracks().forEach((track) => track.stop());
        return;
      }
      stream = acquired;
      video.srcObject = acquired;
      await video.play();
      if (current !== generation) return;
      const surface = document.createElement("canvas");
      canvas = surface;
      const context = surface.getContext("2d", { willReadFrequently: true });
      if (!context) throw new Error("unavailable");
      let previous = -Infinity;
      const scan = (time: number) => {
        if (current !== generation) return;
        if (
          time - previous >= 500 &&
          video.readyState >= 2 &&
          video.videoWidth
        ) {
          try {
            previous = time;
            const ratio = Math.min(
              1,
              1920 / Math.max(video.videoWidth, video.videoHeight),
            );
            surface.width = Math.max(1, Math.round(video.videoWidth * ratio));
            surface.height = Math.max(1, Math.round(video.videoHeight * ratio));
            context.drawImage(video, 0, 0, surface.width, surface.height);
            const found = scanPixels(
              context.getImageData(0, 0, surface.width, surface.height).data,
              surface.width,
              surface.height,
            );
            if (found) {
              stop();
              onFound(found);
              return;
            }
          } catch (error) {
            stop();
            onError(friendly(error));
            return;
          }
        }
        frame = requestAnimationFrame(scan);
      };
      frame = requestAnimationFrame(scan);
    } catch {
      if (current !== generation) return;
      stop();
      onError(
        "The camera isn't available. Choose a QR image or paste the encrypted text instead.",
      );
    }
  }

  return { start, stop };
}
