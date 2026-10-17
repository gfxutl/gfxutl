import { Mic16Regular as Mic, Play16Filled as Play, Record16Filled as Record, Save16Regular as Save, Stop16Filled as Stop } from "@fluentui/react-icons";
import { useEffect, useRef, useState } from "react";
import { BufferTarget, canEncodeAudio, MediaStreamAudioTrackSource, Output, WebMOutputFormat } from "mediabunny";
import { useI18n } from "../core/i18n";
import { saveAudioRecording } from "../core/interface/recording-events";

type RecordingStatus = "idle" | "requesting" | "recording" | "finishing" | "ready" | "saving" | "error";

type AudioRecordingSession = {
  output: Output;
  source: MediaStreamAudioTrackSource;
  target: BufferTarget;
  stream: MediaStream;
};

export function AudioRecordingPanel({ active, onRecordingChange }: { active: boolean; onRecordingChange: (recording: boolean) => void }) {
  const { t } = useI18n();
  const sessionRef = useRef<AudioRecordingSession | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const audioContextRef = useRef<AudioContext | null>(null);
  const analyserFrameRef = useRef(0);
  const startedAtRef = useRef(0);
  const objectUrlRef = useRef<string | null>(null);
  const [status, setStatus] = useState<RecordingStatus>("idle");
  const [elapsed, setElapsed] = useState(0);
  const [level, setLevel] = useState(0);
  const [recordingBlob, setRecordingBlob] = useState<Blob | null>(null);
  const [savedName, setSavedName] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const releaseInput = () => {
    streamRef.current?.getTracks().forEach((track) => track.stop());
    streamRef.current = null;
    if (audioContextRef.current) void audioContextRef.current.close();
    audioContextRef.current = null;
    cancelAnimationFrame(analyserFrameRef.current);
    setLevel(0);
  };

  const finishRecording = async () => {
    const session = sessionRef.current;
    if (!session) return;
    sessionRef.current = null;
    setStatus("finishing");
    session.source.close();
    try {
      await session.output.finalize();
      const buffer = session.target.buffer;
      if (!buffer?.byteLength) throw new Error(t("音声を記録できませんでした"));
      const blob = new Blob([buffer], { type: "audio/webm" });
      if (objectUrlRef.current) URL.revokeObjectURL(objectUrlRef.current);
      objectUrlRef.current = URL.createObjectURL(blob);
      setRecordingBlob(blob);
      setStatus("ready");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : t("録音中にエラーが発生しました"));
      setStatus("error");
      try { if (session.output.state === "started") await session.output.cancel(); } catch { /* The target may already be closed. */ }
    } finally {
      releaseInput();
      onRecordingChange(false);
    }
  };

  useEffect(() => {
    if (status !== "recording") return;
    const timer = window.setInterval(() => setElapsed((performance.now() - startedAtRef.current) / 1000), 100);
    return () => window.clearInterval(timer);
  }, [status]);

  useEffect(() => () => {
    const session = sessionRef.current;
    sessionRef.current = null;
    session?.source.close();
    if (session) void session.output.cancel();
    releaseInput();
    if (objectUrlRef.current) URL.revokeObjectURL(objectUrlRef.current);
  }, []);

  const beginRecording = async () => {
    setError(null);
    setSavedName(null);
    setStatus("requesting");
    let output: Output | null = null;
    try {
      if (!navigator.mediaDevices?.getUserMedia || typeof AudioEncoder === "undefined") throw new Error(t("このブラウザーでは録音を利用できません"));
      if (!await canEncodeAudio("opus")) throw new Error(t("このブラウザーはWebM録音に対応していません"));
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      streamRef.current = stream;
      if (objectUrlRef.current) URL.revokeObjectURL(objectUrlRef.current);
      objectUrlRef.current = null;
      setRecordingBlob(null);
      setElapsed(0);

      const audioContext = new AudioContext();
      audioContextRef.current = audioContext;
      const analyser = audioContext.createAnalyser();
      analyser.fftSize = 256;
      audioContext.createMediaStreamSource(stream).connect(analyser);
      const levels = new Uint8Array(analyser.frequencyBinCount);
      const measure = () => {
        analyser.getByteFrequencyData(levels);
        setLevel(levels.reduce((sum, value) => sum + value, 0) / levels.length / 255);
        analyserFrameRef.current = requestAnimationFrame(measure);
      };
      measure();

      const track = stream.getAudioTracks()[0];
      if (!track) throw new Error(t("マイクの音声トラックを取得できませんでした"));
      const target = new BufferTarget();
      output = new Output({ format: new WebMOutputFormat(), target });
      const source = new MediaStreamAudioTrackSource(track, { codec: "opus", bitrate: 128_000 }, { timestampBase: "zero" });
      output.addAudioTrack(source);
      sessionRef.current = { output, source, target, stream };
      void source.errorPromise.catch((cause) => {
        if (sessionRef.current?.source !== source) return;
        setError(cause instanceof Error ? cause.message : t("録音中にエラーが発生しました"));
        void finishRecording();
      });
      await output.start();
      startedAtRef.current = performance.now();
      setStatus("recording");
      onRecordingChange(true);
    } catch (cause) {
      sessionRef.current = null;
      if (output) {
        try { await output.cancel(); } catch { /* Ignore cleanup errors from a failed start. */ }
      }
      releaseInput();
      onRecordingChange(false);
      if ((cause as DOMException).name === "NotAllowedError") setError(t("マイクへのアクセスが許可されませんでした"));
      else setError(cause instanceof Error ? cause.message : t("録音を開始できませんでした"));
      setStatus("error");
    }
  };

  const saveRecording = async () => {
    if (!recordingBlob) return;
    setStatus("saving");
    setError(null);
    try {
      const name = await saveAudioRecording(recordingBlob, recordingFileName());
      setSavedName(name);
      setStatus("ready");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : t("録音を保存できませんでした"));
      setStatus("ready");
    }
  };

  return <div className={`audio-recording-panel ${active ? "active" : ""}`} aria-hidden={!active}>
    <div className="audio-recording-card">
      <div className={`audio-recording-mark ${status === "recording" ? "live" : ""}`}><Mic /></div>
      <div className="audio-recording-heading">
        <strong>{t("音声収録")}</strong>
        <span>{status === "recording" ? t("録音中") : t("マイク入力をWebM音声として収録します")}</span>
      </div>
      <time>{formatRecordingTime(elapsed)}</time>
      <div className="audio-input-meter" aria-label={t("入力レベル")}><i style={{ width: `${Math.min(100, level * 180)}%` }} /></div>
      <div className="audio-recording-actions">
        {status === "recording"
          ? <button type="button" className="audio-record-stop" onClick={() => void finishRecording()}><Stop />{t("録音を停止")}</button>
          : <button type="button" className="audio-record-start" disabled={status === "requesting" || status === "finishing" || status === "saving"} onClick={() => void beginRecording()}><Record />{status === "requesting" ? t("マイクを準備中…") : status === "finishing" ? t("エンコードを完了中…") : t("録音を開始")}</button>}
        {recordingBlob && objectUrlRef.current && <>
          <audio controls src={objectUrlRef.current}>{t("音声プレビュー")}</audio>
          <button type="button" className="audio-record-save" disabled={status === "saving"} onClick={() => void saveRecording()}><Save />{status === "saving" ? t("保存中…") : t("メディアフォルダへ保存")}</button>
        </>}
      </div>
      {recordingBlob && <div className="audio-recording-ready"><Play />{savedName ? t("{name} を保存しました", { name: savedName }) : t("録音を確認して保存できます")}</div>}
      {error && <div className="audio-recording-error" role="alert">{error}</div>}
    </div>
  </div>;
}

function recordingFileName() {
  const stamp = new Date().toISOString().replace(/[-:]/g, "").replace("T", "-").slice(0, 15);
  return `audio-recording-${stamp}.webm`;
}

function formatRecordingTime(seconds: number) {
  const minutes = Math.floor(seconds / 60).toString().padStart(2, "0");
  const remainder = Math.floor(seconds % 60).toString().padStart(2, "0");
  const tenths = Math.floor((seconds % 1) * 10);
  return `${minutes}:${remainder}.${tenths}`;
}
