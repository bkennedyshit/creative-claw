#include "omni/image/image.h"
#include "omni/image/ai/onnx_segmenter.h"
#include <cstdint>
#include <cstdio>
#include <cstring>
#include <exception>
#include <atomic>

static std::atomic<bool> cpu_only{false};
bool creative_segment_cpu_only() noexcept { return cpu_only.load(std::memory_order_relaxed); }

#if defined(_WIN32)
#define CREATIVE_EXPORT extern "C" __declspec(dllexport)
#else
#define CREATIVE_EXPORT extern "C" __attribute__((visibility("default")))
#endif

// Disabling CUDA is sticky until process restart, matching Gateway config reload.
// This also protects sessions from CUDA DLLs inherited through an existing PATH.
CREATIVE_EXPORT void bridge_segment_cpu_only(int enabled) noexcept {
    if (enabled) cpu_only.store(true, std::memory_order_relaxed);
}

// No C++ exception may cross the C ABI into koffi. Status 2 always means the
// mask is unusable, even though it is filled with a deterministic sentinel.
CREATIVE_EXPORT int bridge_segment_foreground(const uint8_t* pixels, int w, int h,
                                               int channels, uint8_t* out) noexcept {
    if (!pixels || !out || w < 1 || h < 1 || w > 16384 || h > 16384 ||
        (channels != 1 && channels != 3 && channels != 4)) {
        return 1;
    }
    const size_t count = static_cast<size_t>(w) * static_cast<size_t>(h);
    try {
        omni::image::Image image(w, h, channels);
        std::memcpy(image.data.data(), pixels, count * channels);
        const auto mask = omni::image::ai::OnnxSegmenter::instance().run(image);
        if (mask.size() != count) {
            std::memset(out, 255, count);
            return 2;
        }
        std::memcpy(out, mask.data(), count);
        return 0;
    } catch (const std::exception& error) {
        std::fprintf(stderr, "[creative segmentation] %s\n", error.what());
    } catch (...) {
        std::fprintf(stderr, "[creative segmentation] unknown native exception\n");
    }
    std::memset(out, 255, count);
    return 2;
}

CREATIVE_EXPORT int bridge_segment_provider_code() noexcept {
    try {
        const auto provider = omni::image::ai::OnnxSegmenter::instance().active_provider();
        return provider == "cuda" ? 2 : provider == "cpu" ? 1 : 0;
    } catch (...) { return -1; }
}
