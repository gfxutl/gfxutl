import { Pause, Play, RotateCcw, SlidersHorizontal } from "lucide-react";
import { useMemo, useRef, useState, type CSSProperties, type PointerEvent as ReactPointerEvent, type ReactNode } from "react";
import { resolveAudioProcessing } from "../core/interface/audio-processing";
import { useEditor, type AudioProcessingSpec, type MediaAsset, type TimelineClip } from "../core/interface";

export function AudioWaveformEditor({ clip, asset }: { clip: TimelineClip; asset?: MediaAsset }) {
  const { state, controller } = useEditor();
  const processing = resolveAudioProcessing(clip.audioProcessing);
  const [selection, setSelection] = useState<[number, number]>([0, Math.min(clip.duration, 1)]);
  const dragAnchor = useRef<number | null>(null);
  const peaks = useMemo(() => downsamplePeaks(asset?.waveformPeaks ?? [], 260), [asset?.waveformPeaks]);
  const localTime = Math.max(0, Math.min(clip.duration, state.currentTime - clip.start));
  const playhead = clip.duration > 0 ? localTime / clip.duration * 1_000 : 0;
  const selectionStart = Math.min(...selection);
  const selectionEnd = Math.max(...selection);
  const selectionX = clip.duration > 0 ? selectionStart / clip.duration * 1_000 : 0;
  const selectionWidth = clip.duration > 0 ? Math.max(1, (selectionEnd - selectionStart) / clip.duration * 1_000) : 0;

  const updateProcessing = (patch: Partial<AudioProcessingSpec>) => controller.updateAudioProcessing(clip.id, patch);
  const pointTime = (event: ReactPointerEvent<SVGSVGElement>) => {
    const rect = event.currentTarget.getBoundingClientRect();
    return Math.max(0, Math.min(clip.duration, (event.clientX - rect.left) / Math.max(1, rect.width) * clip.duration));
  };
  const beginSelection = (event: ReactPointerEvent<SVGSVGElement>) => {
    const time = pointTime(event);
    dragAnchor.current = time;
    event.currentTarget.setPointerCapture(event.pointerId);
    setSelection([time, time]);
    controller.setTime(clip.start + time);
  };
  const moveSelection = (event: ReactPointerEvent<SVGSVGElement>) => {
    if (dragAnchor.current === null) return;
    setSelection([dragAnchor.current, pointTime(event)]);
  };
  const endSelection = () => { dragAnchor.current = null; };

  return <div className="audio-waveform-editor" data-audio-clip-id={clip.id} data-playing={state.playing} data-playing-audio-objects={state.playingAudioObjects} data-current-time={state.currentTime} data-clip-start={clip.start} data-clip-duration={clip.duration}>
    <header className="audio-editor-toolbar">
      <button type="button" className="audio-play" aria-label={state.playing ? "音声を停止" : "音声を再生"} onClick={controller.togglePlayback}>{state.playing ? <Pause /> : <Play />}</button>
      <div><strong>{clip.name}</strong><small>{asset?.codec ?? "AUDIO"} · {formatTime(clip.duration)}</small></div>
      <span className="audio-selection-readout">選択 {formatTime(selectionStart)} – {formatTime(selectionEnd)}</span>
      <label className="audio-bypass"><input type="checkbox" checked={!processing.enabled} onChange={(event) => updateProcessing({ enabled: !event.target.checked })} /> BYPASS</label>
      <button type="button" className="audio-reset" onClick={() => { controller.updateClip(clip.id, { volume: 0, pan: 0 }); controller.updateAudioProcessing(clip.id, resolveAudioProcessing()); }}><RotateCcw />リセット</button>
    </header>

    <div className="audio-waveform-surface">
      <div className="audio-ruler">{Array.from({ length: 9 }, (_, index) => <span key={index} style={{ left: `${index * 12.5}%` }}>{(clip.duration * index / 8).toFixed(1)}s</span>)}</div>
      <svg viewBox="0 0 1000 240" preserveAspectRatio="none" role="slider" aria-label="音声波形と選択範囲" aria-valuemin={0} aria-valuemax={clip.duration} aria-valuenow={localTime} tabIndex={0} onPointerDown={beginSelection} onPointerMove={moveSelection} onPointerUp={endSelection} onPointerCancel={endSelection}>
        <defs><linearGradient id={`wave-${clip.id}`} x1="0" y1="0" x2="0" y2="1"><stop offset="0" stopColor="#a9d7c4"/><stop offset="1" stopColor="#4e8a73"/></linearGradient></defs>
        <line className="wave-zero" x1="0" y1="120" x2="1000" y2="120" />
        {peaks.length ? peaks.map((peak, index) => {
          const x = index / peaks.length * 1_000;
          const height = Math.max(2, peak * 108);
          return <rect key={index} x={x} y={120 - height} width={Math.max(1.4, 880 / peaks.length)} height={height * 2} rx="1" fill={`url(#wave-${clip.id})`} />;
        }) : <text x="500" y="125" textAnchor="middle">波形を解析中…</text>}
        <rect className="wave-selection" x={selectionX} y="0" width={selectionWidth} height="240" />
        {processing.fadeIn > 0 && <path className="wave-envelope" d={`M 0 120 L ${Math.min(1000, processing.fadeIn / clip.duration * 1000)} 16`} />}
        {processing.fadeOut > 0 && <path className="wave-envelope" d={`M ${Math.max(0, 1000 - processing.fadeOut / clip.duration * 1000)} 16 L 1000 120`} />}
        <line className="wave-playhead" x1={playhead} y1="0" x2={playhead} y2="240" />
      </svg>
      <div className="audio-waveform-actions">
        <button type="button" onClick={() => updateProcessing({ fadeIn: Math.max(0, selectionEnd - selectionStart) })}>選択長でフェードイン</button>
        <button type="button" onClick={() => updateProcessing({ fadeOut: Math.max(0, selectionEnd - selectionStart) })}>選択長でフェードアウト</button>
        <button type="button" onClick={() => controller.setTime(clip.start + selectionStart)}>選択先頭へ</button>
      </div>
    </div>

    <div className="audio-processing-rack">
      <AudioModule title="レベル" badge="LEVEL">
        <AudioKnob label="ゲイン" value={clip.volume ?? 0} min={-60} max={12} step={0.5} unit="dB" onChange={(volume) => controller.updateClip(clip.id, { volume })} />
        <AudioKnob label="パン" value={clip.pan ?? 0} min={-100} max={100} step={1} unit="" onChange={(pan) => controller.updateClip(clip.id, { pan })} />
        <AudioKnob label="Fade in" value={processing.fadeIn} min={0} max={Math.max(0.1, clip.duration)} step={0.05} unit="s" onChange={(fadeIn) => updateProcessing({ fadeIn })} />
        <AudioKnob label="Fade out" value={processing.fadeOut} min={0} max={Math.max(0.1, clip.duration)} step={0.05} unit="s" onChange={(fadeOut) => updateProcessing({ fadeOut })} />
      </AudioModule>
      <AudioModule title="イコライザー" badge="4 BAND EQ">
        <AudioKnob label="Low cut" value={processing.lowCutHz} min={10} max={500} step={5} unit="Hz" onChange={(lowCutHz) => updateProcessing({ lowCutHz })} />
        <AudioKnob label="Low" value={processing.lowShelfDb} min={-18} max={18} step={0.5} unit="dB" onChange={(lowShelfDb) => updateProcessing({ lowShelfDb })} />
        <AudioKnob label="Mid" value={processing.midPeakDb} min={-18} max={18} step={0.5} unit="dB" onChange={(midPeakDb) => updateProcessing({ midPeakDb })} />
        <AudioKnob label="Mid Freq" value={processing.midFrequencyHz} min={100} max={8_000} step={25} unit="Hz" onChange={(midFrequencyHz) => updateProcessing({ midFrequencyHz })} />
        <AudioKnob label="High" value={processing.highShelfDb} min={-18} max={18} step={0.5} unit="dB" onChange={(highShelfDb) => updateProcessing({ highShelfDb })} />
        <AudioKnob label="High cut" value={processing.highCutHz} min={1_000} max={22_000} step={100} unit="Hz" onChange={(highCutHz) => updateProcessing({ highCutHz })} />
      </AudioModule>
      <AudioModule title="ダイナミクス" badge="COMPRESSOR">
        <AudioKnob label="Threshold" value={processing.compressorThresholdDb} min={-80} max={0} step={1} unit="dB" onChange={(compressorThresholdDb) => updateProcessing({ compressorThresholdDb })} />
        <AudioKnob label="Ratio" value={processing.compressorRatio} min={1} max={20} step={0.5} unit=":1" onChange={(compressorRatio) => updateProcessing({ compressorRatio })} />
        <AudioKnob label="Attack" value={processing.compressorAttack} min={0} max={1} step={0.005} unit="s" onChange={(compressorAttack) => updateProcessing({ compressorAttack })} />
        <AudioKnob label="Release" value={processing.compressorRelease} min={0.01} max={1} step={0.01} unit="s" onChange={(compressorRelease) => updateProcessing({ compressorRelease })} />
      </AudioModule>
      <AudioModule title="空間" badge="REVERB / DELAY">
        <AudioKnob label="Reverb" value={processing.reverbMix} min={0} max={100} step={1} unit="%" onChange={(reverbMix) => updateProcessing({ reverbMix })} />
        <AudioKnob label="Decay" value={processing.reverbDecay} min={0.1} max={8} step={0.1} unit="s" onChange={(reverbDecay) => updateProcessing({ reverbDecay })} />
        <AudioKnob label="Delay" value={processing.delayMix} min={0} max={100} step={1} unit="%" onChange={(delayMix) => updateProcessing({ delayMix })} />
        <AudioKnob label="Time" value={processing.delayTime} min={0} max={2} step={0.01} unit="s" onChange={(delayTime) => updateProcessing({ delayTime })} />
        <AudioKnob label="Feedback" value={processing.delayFeedback} min={0} max={0.92} step={0.01} unit="" onChange={(delayFeedback) => updateProcessing({ delayFeedback })} />
      </AudioModule>
    </div>
  </div>;
}

function AudioModule({ title, badge, children }: { title: string; badge: string; children: ReactNode }) {
  return <section className="audio-module"><header><SlidersHorizontal /><strong>{title}</strong><small>{badge}</small></header><div>{children}</div></section>;
}

function AudioKnob({ label, value, min, max, step, unit, onChange }: { label: string; value: number; min: number; max: number; step: number; unit: string; onChange: (value: number) => void }) {
  const ratio = Math.max(0, Math.min(1, (value - min) / Math.max(0.0001, max - min)));
  return <label className="audio-knob"><span className="audio-knob-dial" style={{ "--knob-angle": `${-135 + ratio * 270}deg` } as CSSProperties}><i /></span><span>{label}</span><input aria-label={label} type="range" value={value} min={min} max={max} step={step} onChange={(event) => onChange(Number(event.target.value))} /><output>{formatValue(value)}{unit}</output></label>;
}

function downsamplePeaks(values: number[], limit: number) {
  if (values.length <= limit) return values;
  return Array.from({ length: limit }, (_, index) => {
    const start = Math.floor(index * values.length / limit);
    const end = Math.max(start + 1, Math.floor((index + 1) * values.length / limit));
    return Math.max(...values.slice(start, end));
  });
}

function formatTime(seconds: number) {
  const safe = Math.max(0, seconds);
  return `${Math.floor(safe / 60).toString().padStart(2, "0")}:${Math.floor(safe % 60).toString().padStart(2, "0")}.${Math.floor(safe % 1 * 100).toString().padStart(2, "0")}`;
}

function formatValue(value: number) {
  return Math.abs(value) >= 100 ? Math.round(value).toString() : Number(value.toFixed(2)).toString();
}
