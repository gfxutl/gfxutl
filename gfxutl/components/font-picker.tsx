import { Check, ChevronDown } from "lucide-react";
import { Fragment, useEffect, useMemo, useRef, useState } from "react";
import type { FontFaceInfo } from "../core/interface";

const FONT_LOAD_GROUP_SIZE = 6;

type FontPickerProps = {
  fonts: FontFaceInfo[];
  value?: string;
  onChange: (fontId: string) => void;
  loadPreview: (fontId: string) => Promise<string | undefined>;
};

export function FontPicker({ fonts, value = "", onChange, loadPreview }: FontPickerProps) {
  const [open, setOpen] = useState(false);
  const [selectedPreviewFamily, setSelectedPreviewFamily] = useState<string>();
  const [previewFamilies, setPreviewFamilies] = useState<Record<string, string>>({});
  const rootRef = useRef<HTMLDivElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const selectedFont = fonts.find((font) => font.postscriptName === value);
  const fontGroups = useMemo(() => Array.from({ length: Math.ceil(fonts.length / FONT_LOAD_GROUP_SIZE) }, (_, index) => (
    fonts.slice(index * FONT_LOAD_GROUP_SIZE, (index + 1) * FONT_LOAD_GROUP_SIZE)
  )), [fonts]);

  useEffect(() => {
    let cancelled = false;
    setSelectedPreviewFamily(undefined);
    if (selectedFont) void loadPreview(selectedFont.postscriptName).then((family) => {
      if (!cancelled) setSelectedPreviewFamily(family);
    });
    return () => { cancelled = true; };
  }, [loadPreview, selectedFont]);

  useEffect(() => setPreviewFamilies({}), [fonts]);

  useEffect(() => {
    const list = listRef.current;
    if (!open || !list) return;
    let cancelled = false;
    const loadGroup = (index: number) => {
      const group = fontGroups[index];
      if (!group) return;
      void Promise.all(group.map(async (font) => [font.postscriptName, await loadPreview(font.postscriptName)] as const))
        .then((entries) => {
          if (cancelled) return;
          const loaded = Object.fromEntries(entries.filter((entry): entry is readonly [string, string] => Boolean(entry[1])));
          setPreviewFamilies((current) => ({ ...current, ...loaded }));
        });
    };
    const markers = list.querySelectorAll<HTMLElement>(".font-load-marker");
    if (!("IntersectionObserver" in window)) {
      markers.forEach((marker) => loadGroup(Number(marker.dataset.fontGroup)));
      return () => { cancelled = true; };
    }
    const observer = new IntersectionObserver((entries) => {
      entries.forEach((entry) => {
        if (!entry.isIntersecting) return;
        observer.unobserve(entry.target);
        loadGroup(Number((entry.target as HTMLElement).dataset.fontGroup));
      });
    }, { root: list, rootMargin: "150px 0px" });
    markers.forEach((marker) => observer.observe(marker));
    return () => {
      cancelled = true;
      observer.disconnect();
    };
  }, [fontGroups, loadPreview, open]);

  useEffect(() => {
    if (!open) return;
    const closeOnOutsideClick = (event: PointerEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(false);
    };
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") setOpen(false);
    };
    window.addEventListener("pointerdown", closeOnOutsideClick, { capture: true });
    window.addEventListener("keydown", closeOnEscape, { capture: true });
    return () => {
      window.removeEventListener("pointerdown", closeOnOutsideClick, { capture: true });
      window.removeEventListener("keydown", closeOnEscape, { capture: true });
    };
  }, [open]);

  const choose = (fontId: string) => {
    setOpen(false);
    onChange(fontId);
  };

  return <div className="select-field font-picker-field">
    <span>フォント</span>
    <div className="font-picker" ref={rootRef}>
      <button
        type="button"
        role="combobox"
        aria-label="フォント"
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls="font-picker-list"
        className="font-picker-trigger"
        onClick={() => setOpen((current) => !current)}
      >
        <span style={selectedPreviewFamily ? { fontFamily: selectedPreviewFamily } : undefined}>
          {selectedFont ? `${selectedFont.family} ${selectedFont.style}` : "Helvetiker（内蔵）"}
        </span>
        <ChevronDown aria-hidden="true" />
      </button>
      {open && <div id="font-picker-list" ref={listRef} className="font-picker-list" role="listbox" aria-label="フォント一覧">
        <button type="button" role="option" aria-selected={!value} className={!value ? "selected builtin" : "builtin"} onClick={() => choose("")}>
          <Check aria-hidden="true" /><span>Helvetiker</span><small>内蔵</small>
        </button>
        {fontGroups.map((group, groupIndex) => <Fragment key={group[0].postscriptName}>
          <span className="font-load-marker" data-font-group={groupIndex} aria-hidden="true" />
          {group.map((font) => {
            const previewFamily = previewFamilies[font.postscriptName];
            const selected = value === font.postscriptName;
            return <button
              key={font.postscriptName}
              type="button"
              role="option"
              aria-selected={selected}
              className={selected ? "selected" : undefined}
              data-font-id={font.postscriptName}
              data-font-loaded={previewFamily ? "true" : "false"}
              onClick={() => choose(font.postscriptName)}
            >
              <Check aria-hidden="true" />
              <span style={previewFamily ? { fontFamily: previewFamily } : undefined}>{font.family}</span>
              <small>{font.style}</small>
            </button>;
          })}
        </Fragment>)}
      </div>}
    </div>
  </div>;
}
