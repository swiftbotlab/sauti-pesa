// AudioWorklet: copies microphone samples (mono, Float32) to the page, which encodes a 16-bit PCM WAV.
// No network, no storage: the audio only goes to the local engine when the person stops recording.
class PcmRecorder extends AudioWorkletProcessor {
  process (inputs) {
    const ch = inputs[0] && inputs[0][0]
    if (ch && ch.length) this.port.postMessage(ch.slice(0))
    return true
  }
}
registerProcessor('pcm-recorder', PcmRecorder)
