const framerate = 30_000 / 1001;
const width = 1920;
const height = 1080;
const gopSize = 60;

function playVideoAsync(video: HTMLVideoElement): Promise<void> {
    return new Promise(resolve => {
        video.addEventListener('canplaythrough', () => {
            video.play();
            resolve();
        });
    });
}

function requestVideoFrameAsync(video: HTMLVideoElement): Promise<VideoFrame> {
    return new Promise(resolve => {
        video.requestVideoFrameCallback((time, metadata) => {
            resolve(new VideoFrame(video, {
                timestamp: metadata.mediaTime * 1_000_000,
                duration: 1_000_000 / framerate,
                alpha: 'discard'
            }));
        });
    });
}

function createVideoReader(url: URL, canvas: HTMLCanvasElement): ReadableStream<VideoFrame> {
    const video = document.createElement('video');
    video.src = url.href;
    video.muted = true;
    const playPromise = playVideoAsync(video);
    let frameCount = 0;
    const ctx = canvas.getContext('2d')!;

    return new ReadableStream({
        start(controller) {
            video.addEventListener('ended', () => {
                controller.close();
                console.log(`Frame count: ${frameCount}`);
            });
        },

        async pull(controller) {
            await playPromise;
            const frame = await requestVideoFrameAsync(video);
            controller.enqueue(frame);

            frameCount += 1;
            canvas.width = video.videoWidth;
            canvas.height = video.videoHeight;
            ctx.drawImage(frame, 0, 0);
        }
    });
}

function teeVideoFrames(input: ReadableStream<VideoFrame>): ReadableStream<VideoFrame>[] {
    const reader = input.getReader();
    const outputs: ReadableStream<VideoFrame>[] = [];
    const controllers: ReadableStreamController<VideoFrame>[] = [];

    for (let i = 0; i < 2; i += 1) {
        outputs.push(new ReadableStream({
            start(controller) {
                controllers.push(controller);
            },

            async pull() {
                const result = await reader.read();
                controllers.forEach(controller => {
                    if (result.done) {
                        controller.close();
                    } else {
                        controller.enqueue(result.value.clone());
                    }
                });
                result.value?.close();
            }
        }));
    }
    return outputs;
}

function createVideoEncoderTransform(config: Partial<VideoEncoderConfig>): TransformStream<VideoFrame, EncodedVideoChunk> {
    let videoEncoder: VideoEncoder;
    let frameIndex = 0;

    return new TransformStream({
        start(controller) {
            videoEncoder = new VideoEncoder({
                output: chunk => controller.enqueue(chunk),
                error: error => controller.error(error)
            });
            videoEncoder.configure({
                codec: 'avc1.420029',
                avc: {
                    format: 'annexb',
                },
                width,
                height,
                framerate,
                bitrate: 8_000_000,
                ...config
            });
        },

        transform(frame) {
            // Hardware-accel doesn't automatically insert key-frames so we have
            // to manually force them
            const keyFrame = frameIndex % gopSize === 0;
            frameIndex += 1;
            videoEncoder.encode(frame, { keyFrame });
            frame.close();
        },

        async flush(controller): Promise<void> {
            await videoEncoder.flush();
            controller.terminate();
        }
    });
}

function createBitrateCalculator(name: string): WritableStream<EncodedVideoChunk> {
    let totalSize = 0;
    let endTime = 0;

    return new WritableStream({
        write(chunk) {
            totalSize += chunk.byteLength;
            endTime = (chunk.timestamp + (chunk.duration ?? 0)) / 1_000_000;
        },

        close() {
            const bitrate = Math.round((totalSize * 8) / endTime);
            console.log(`Bitrate (${name}): ${bitrate}`);
        }
    })
}

const canvas = document.querySelector('canvas')!;
const video = createVideoReader(new URL('./test-media/Aspen.mp4', import.meta.url), canvas);
const [software, hardware] = teeVideoFrames(video);
software
    .pipeThrough(createVideoEncoderTransform({ hardwareAcceleration: 'prefer-software' }))
    .pipeTo(createBitrateCalculator('software'));
hardware
    .pipeThrough(createVideoEncoderTransform({ hardwareAcceleration: 'prefer-hardware' }))
    .pipeTo(createBitrateCalculator('hardware'));
