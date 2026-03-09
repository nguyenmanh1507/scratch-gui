import 'get-float-time-domain-data';
import getUserMedia from 'get-user-media-promise';
import SharedAudioContext from './shared-audio-context.js';
import {computeRMS, computeChunkedRMS} from './audio-util.js';

class AudioRecorder {
    constructor () {
        this.audioContext = new SharedAudioContext();
        this.previousAudioSessionType = null;
        this.bufferLength = 8192;

        this.userMediaStream = null;
        this.mediaStreamSource = null;
        this.sourceNode = null;
        this.scriptProcessorNode = null;

        this.recordedSamples = 0;
        this.recording = false;
        this.started = false;
        this.buffers = [];

        this.disposed = false;
    }

    startListening (onStarted, onUpdate, onError) {
        try {

            // AudioSession in learner app defaults to 'playback',
            // which causes InvalidStateError on Safari when get user media.
            // Switch to 'play-and-record' before requesting
            // the microphone to avoid InvalidStateError on Safari.
            if (typeof navigator !== 'undefined' && navigator.audioSession) {
                this.previousAudioSessionType = navigator.audioSession.type;
                navigator.audioSession.type = 'play-and-record';
            }
            getUserMedia({audio: true})
                .then(userMediaStream => {
                    if (!this.disposed) {
                        this.started = true;
                        onStarted();
                        this.attachUserMediaStream(userMediaStream, onUpdate);
                    }
                })
                .catch(e => {
                    if (!this.disposed) {
                        onError(e);
                    }
                });
        } catch (e) {
            if (!this.disposed) {
                onError(e);
            }
        }
    }

    startRecording () {
        this.recording = true;
    }

    attachUserMediaStream (userMediaStream, onUpdate) {
        this.userMediaStream = userMediaStream;
        this.mediaStreamSource = this.audioContext.createMediaStreamSource(userMediaStream);
        this.sourceNode = this.audioContext.createGain();
        this.scriptProcessorNode = this.audioContext.createScriptProcessor(this.bufferLength, 1, 1);

        this.scriptProcessorNode.onaudioprocess = processEvent => {
            if (this.recording && !this.disposed) {
                this.buffers.push(new Float32Array(processEvent.inputBuffer.getChannelData(0)));
            }
        };

        this.analyserNode = this.audioContext.createAnalyser();

        this.analyserNode.fftSize = 2048;

        const bufferLength = this.analyserNode.frequencyBinCount;
        const dataArray = new Float32Array(bufferLength);

        const update = () => {
            if (this.disposed) return;
            this.analyserNode.getFloatTimeDomainData(dataArray);
            onUpdate(computeRMS(dataArray));
            requestAnimationFrame(update);
        };

        requestAnimationFrame(update);

        // Wire everything together, ending in the destination
        this.mediaStreamSource.connect(this.sourceNode);
        this.sourceNode.connect(this.analyserNode);
        this.analyserNode.connect(this.scriptProcessorNode);
        this.scriptProcessorNode.connect(this.audioContext.destination);
    }

    stop () {
        const buffer = new Float32Array(this.buffers.length * this.bufferLength);

        let offset = 0;
        for (let i = 0; i < this.buffers.length; i++) {
            const bufferChunk = this.buffers[i];
            buffer.set(bufferChunk, offset);
            offset += bufferChunk.length;
        }

        const chunkLevels = computeChunkedRMS(buffer);
        const maxRMS = Math.max.apply(null, chunkLevels);
        const threshold = maxRMS / 8;

        let firstChunkAboveThreshold = null;
        let lastChunkAboveThreshold = null;
        for (let i = 0; i < chunkLevels.length; i++) {
            if (chunkLevels[i] > threshold) {
                if (firstChunkAboveThreshold === null) firstChunkAboveThreshold = i + 1;
                lastChunkAboveThreshold = i + 1;
            }
        }

        let trimStart = Math.max(2, firstChunkAboveThreshold - 2) / this.buffers.length;
        let trimEnd = Math.min(this.buffers.length - 2, lastChunkAboveThreshold + 2) / this.buffers.length;

        // With very few samples, the automatic trimming can produce invalid values
        if (trimStart >= trimEnd) {
            trimStart = 0;
            trimEnd = 1;
        }

        return {
            levels: chunkLevels,
            samples: buffer,
            sampleRate: this.audioContext.sampleRate,
            trimStart: trimStart,
            trimEnd: trimEnd
        };
    }

    dispose () {
        if (this.started) {
            this.scriptProcessorNode.onaudioprocess = null;
            this.scriptProcessorNode.disconnect();
            this.analyserNode.disconnect();
            this.sourceNode.disconnect();
            this.mediaStreamSource.disconnect();
            this.userMediaStream.getAudioTracks()[0].stop();
        }
        // Restore the original AudioSession type so playback-only audio
        // elsewhere in the app is not affected after recording ends.
        if (typeof navigator !== 'undefined' && navigator.audioSession && this.previousAudioSessionType) {
            navigator.audioSession.type = this.previousAudioSessionType;
        }
        this.disposed = true;
    }
}

export default AudioRecorder;
