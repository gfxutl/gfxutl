import { Checkmark16Regular as Check, ChevronDown16Regular as ChevronDown, Search16Regular as Search } from "@fluentui/react-icons";
import { Fragment, useEffect, useMemo, useRef, useState } from "react";
import type { FontFaceInfo } from "../core/interface";
import { useI18n } from "../core/i18n";

const FONT_LOAD_GROUP_SIZE = 6;

type FontPickerProps = {
  fonts: FontFaceInfo[];
  value?: string;
  onChange: (fontId: string) => void;
  onOpen: () => void;
  loadPreview: (fontId: string) => Promise<string | undefined>;
};

export function FontPicker({ fonts, value = "", onChange, onOpen, loadPreview }: FontPickerProps) {
  const { t } = useI18n();
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [selectedPreviewFamily, setSelectedPreviewFamily] = useState<string>();
  const [previewFamilies, setPreviewFamilies] = useState<Record<string, string>>({});
  const rootRef = useRef<HTMLDivElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const selectedFont = fonts.find((font) => font.postscriptName === value);
  const normalizedQuery = query.trim().normalize("NFKC").toLocaleLowerCase();
  const filteredFonts = useMemo(() => normalizedQuery
    ? fonts.filter((font) => `${font.family} ${font.style} ${font.postscriptName}`.normalize("NFKC").toLocaleLowerCase().includes(normalizedQuery))
    : fonts, [fonts, normalizedQuery]);
  const showBuiltin = !normalizedQuery || "helvetiker 内蔵 builtin".includes(normalizedQuery);
  const fontGroups = useMemo(() => Array.from({ length: Math.ceil(filteredFonts.length / FONT_LOAD_GROUP_SIZE) }, (_, index) => (
    filteredFonts.slice(index * FONT_LOAD_GROUP_SIZE, (index + 1) * FONT_LOAD_GROUP_SIZE)
  )), [filteredFonts]);

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
    if (!open) return;
    setQuery("");
    searchRef.current?.focus();
  }, [open]);

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
    <span>{t("フォント")}</span>
    <div className="font-picker" ref={rootRef}>
      <button
        type="button"
        role="combobox"
        aria-label={t("フォント")}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls="font-picker-list"
        className="font-picker-trigger"
        onClick={() => {
          if (!open) onOpen();
          setOpen((current) => !current);
        }}
      >
        <span style={selectedPreviewFamily ? { fontFamily: selectedPreviewFamily } : undefined}>
          {selectedFont ? `${selectedFont.family} ${selectedFont.style}` : t("Helvetiker（内蔵）")}
        </span>
        <ChevronDown aria-hidden="true" />
      </button>
      {open && <div className="font-picker-list">
        <label className="font-picker-search">
          <Search aria-hidden="true" />
          <input ref={searchRef} type="search" value={query} placeholder={t("フォント名を検索")} aria-label={t("フォント名を検索")} onChange={(event) => setQuery(event.target.value)} />
        </label>
        <div id="font-picker-list" ref={listRef} className="font-picker-options" role="listbox" aria-label={t("フォント一覧")}>
          {showBuiltin && <button type="button" role="option" aria-selected={!value} className={!value ? "selected builtin" : "builtin"} onClick={() => choose("")}>
            <Check aria-hidden="true" /><span>Helvetiker</span><small>{t("内蔵")}</small>
          </button>}
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
          {!showBuiltin && filteredFonts.length === 0 && <div className="font-picker-empty">{t("該当するフォントがありません")}</div>}
        </div>
      </div>}
    </div>
  </div>;
}
