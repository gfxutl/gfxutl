import { useI18n } from "../core/i18n";
import { useEffect } from "react";

type TableRow = {
  name: string;
  description: string;
  meta?: string;
  href?: string;
};

const REPOSITORY_URL = "https://github.com/gfxutl/gfxutl";

function SectionBand({ children }: { children: string }) {
  return <h2 className="about-band">★ {children} ★</h2>;
}
function DownloadTable({ title, intro, rows }: { title: string; intro: string; rows: TableRow[] }) {
  return <table className="about-table">
    <thead><tr><th colSpan={3}>{title}</th></tr></thead>
    <tbody>
      <tr><td colSpan={3} className="about-table-intro">{intro}</td></tr>
      {rows.map((row) => <tr key={`${title}-${row.name}`}>
        <td>{row.href ? <a href={row.href}>{row.name}</a> : row.name}</td>
        <td>{row.description}</td>
        <td>{row.meta ?? "—"}</td>
      </tr>)}
    </tbody>
  </table>;
}

export function AboutPage() {
  const { t } = useI18n();
  useEffect(() => { document.title = t("GfxUtlのお部屋"); }, [t]);
  return <main className="about-page">
    <div className="about-utility"><small>{t("ブラウザーで動く映像編集環境")}</small><a href="/">{t("GfxUtlを起動")}</a></div>
    <hr />
    <header className="about-header">
      <div className="about-header-copy"><h1>{t("GfxUtlのお部屋")}</h1><p>{t("「つくるかい？」")}</p></div>
      <div className="about-mascot" aria-hidden="true"><i>G</i><span>fx</span></div>
    </header>
    <hr />

    <section className="about-intro">
      <SectionBand>{t("GfxUtlとは…")}</SectionBand>
      <p>{t("ブラウザ上で映像、画像、音声、テキスト、3Dオブジェクトを組み合わせる動画編集ツールです。")}</p>
      <p>{t("インストールせずにモーショングラフィクスを制作し、映像ファイルや静止画として出力できます。")}</p>
    </section>

    <hr />
    <section className="about-information">
      <SectionBand>{t("インフォメーション")}</SectionBand>
      <p>{t("GfxUtlの編集基盤とモーショングラフィクス機能を公開しました。")}</p>
      <p>{t("WebGPU、WebCodecs、Three.js、MediaBunnyを利用してブラウザ内で編集から書き出しまで完結します。")}</p>
      <table className="about-news"><tbody>
        <tr><td>2026/10/11</td><td><a href="/">{t("タイムライン操作とプロジェクト保存機能を更新")}</a></td></tr>
        <tr><td>2026/10/11</td><td><a href="/">{t("シーンアニメーション、マスク、シェイプ編集を公開")}</a></td></tr>
        <tr><td>2026/10/11</td><td><a href={REPOSITORY_URL}>{t("GfxUtl version0.1.0 を公開")}</a></td></tr>
      </tbody></table>
      <p className="about-community">{t("— 制作物や不具合報告はGitHubで共有して頂けると励みになります…！")}</p>
    </section>

    <hr />
    <section className="about-downloads">
      <SectionBand>{t("ダウンロード")}</SectionBand>
      <DownloadTable title="GfxUtl Web Edition" intro={t("映像、画像、テキスト、3Dオブジェクトを自由に配置・加工し、ブラウザからファイルへ出力する編集環境です。") } rows={[
        { name: t("GfxUtlを起動"), description: t("最新版・インストール不要"), meta: "Web Application", href: "/" },
        { name: "gfxutl source", description: t("TypeScript / React ソースコード"), meta: "GitHub", href: REPOSITORY_URL },
        { name: "README", description: t("動作環境と技術構成"), meta: "Documentation", href: `${REPOSITORY_URL}#readme` },
      ]} />
      <p className="about-table-link"><a href={REPOSITORY_URL}>{t("更新履歴とソースコードはこちら")}</a></p>

      <DownloadTable title={t("動作環境")} intro={t("ローカルファイルを安全に扱うため、HTTPSで提供されるChromium系ブラウザを推奨します。")} rows={[
        { name: "WebGPU", description: t("GPUレンダリング。未対応環境ではWebGL 2へ切替"), meta: t("推奨") },
        { name: "WebCodecs", description: t("動画・音声のデコードとプレビューキャッシュ"), meta: t("必須") },
        { name: "File System Access", description: t("プロジェクトと素材の読み書き。通常のファイル選択へ代替可能"), meta: t("任意") },
      ]} />

      <DownloadTable title={t("編集機能")} intro={t("フリーレイアウトのタイムラインとThree.jsシーンを一体化した編集機能です。")} rows={[
        { name: t("タイムライン"), description: t("自由配置、グループ、スナップ、マーカー、キーフレーム"), meta: "Core" },
        { name: t("モーショングラフィクス"), description: t("Bezier補間、マスク、シェイプ、パーティクル、シーンアニメーション"), meta: "Motion" },
        { name: t("プレビュー"), description: t("H.264 RAMプレビュー、音声同期、別ウィンドウ表示"), meta: "Preview" },
        { name: t("プロジェクト"), description: t("Undo / Redo、.gfxutl保存、FileSystemHandle永続化"), meta: "Project" },
      ]} />

      <DownloadTable title="FilterPlugin" intro={t("クリップごとに順序を入れ替えられるリアルタイム効果スタックです。")} rows={[
        { name: "brightness / contrast", description: t("明るさ、コントラスト、彩度、ガンマ、色相"), meta: "Built-in" },
        { name: "chromaKey", description: t("クロマキー、ビネット、ピクセル化、色調"), meta: "Built-in" },
        { name: "mask", description: t("矩形・楕円、加算・減算・交差、反転、ぼかし"), meta: "Built-in" },
      ]} />

      <DownloadTable title={t("出力Plugin")} intro={t("専用WorkerでThree.jsの描画結果と音声をエンコードします。")} rows={[
        { name: "MP4 output", description: t("H.264 / AACによる動画出力"), meta: "MediaBunny" },
        { name: "WebM output", description: t("VP9 / Opusによる動画出力"), meta: "MediaBunny" },
        { name: "PNG output", description: t("現在フレームの静止画出力"), meta: "Lossless" },
      ]} />

      <DownloadTable title="PluginSDK" intro={t("GfxUtlの実装、プロトコル、レンダーエンジンはリポジトリで確認できます。")} rows={[
        { name: "Engine protocol", description: t("UIとWorker間のstructured-clone可能な共有契約"), meta: "TypeScript", href: `${REPOSITORY_URL}/tree/main/gfxutl/core/protocol` },
        { name: "Renderer core", description: t("Three.js WebGPU / WebGLレンダー基盤"), meta: "TypeScript", href: `${REPOSITORY_URL}/tree/main/gfxutl/core/engine` },
      ]} />

      <DownloadTable title="Omake" intro={t("制作を支えるライブラリとブラウザ標準技術です。")} rows={[
        { name: "Three.js", description: t("3Dシーン、WebGPU、TSLレンダリング"), meta: "three.js", href: "https://threejs.org/" },
        { name: "MediaBunny", description: t("メディア解析、デコード、エンコード"), meta: "media toolkit", href: "https://mediabunny.dev/" },
      ]} />

      <DownloadTable title={t("関連サイトリンク")} intro={t("GfxUtlで利用している技術や仕様を公開されているサイトへのリンクです。")} rows={[
        { name: "WebGPU", description: t("ブラウザ向けGPU APIの仕様と解説"), meta: "W3C", href: "https://www.w3.org/TR/webgpu/" },
        { name: "WebCodecs", description: t("低レベルな動画・音声コーデックAPI"), meta: "W3C", href: "https://www.w3.org/TR/webcodecs/" },
        { name: "React", description: t("GfxUtlのインターフェースを構成するUIライブラリ"), meta: "react.dev", href: "https://react.dev/" },
      ]} />
    </section>

    <hr />
    <section className="about-related">
      <SectionBand>{t("関連動画リンク")}</SectionBand>
      <p>{t("GitHubで公開されているGfxUtlの実装と更新履歴へのリンクです。")}</p>
      <div className="about-video-grid">
        <article><strong>{t("モーショングラフィクス")}</strong><div className="about-video-placeholder">GfxUtl</div><p>{t("キーフレーム、Bezier補間、マスク、シェイプを組み合わせた編集に対応しています。")}</p></article>
        <article><strong>{t("3Dコンポジット")}</strong><div className="about-video-placeholder">WebGPU</div><p>{t("カメラ、ライト、glTF、パーティクルを同一タイムライン上で扱えます。")}</p></article>
        <article><strong>{t("ブラウザ書き出し")}</strong><div className="about-video-placeholder">MP4 / WebM</div><p>{t("映像と音声を専用Workerで処理し、ローカルへ保存できます。")}</p></article>
      </div>
    </section>

    <hr />
    <section className="about-illustration">
      <SectionBand>{t("関連イラスト")}</SectionBand>
      <p>{t("GfxUtlの「映像を組み立てるデッキ」をイメージしたマークです。")}</p>
      <div className="about-illustration-table">
        <div className="about-large-mark" aria-label="GfxUtl mark"><i>G</i><span>fx</span></div><div /><div />
        <p>{t("複数のレイヤーを重ね、動きと時間をひとつの画面で扱うイメージを形にしています。")}</p><div /><div />
      </div>
    </section>

    <hr />
    <section className="about-notice">
      <SectionBand>{t("使用上の注意")}</SectionBand>
      <div>
        <p>{t("GfxUtlはオープンソースのWebアプリケーションです。")}</p>
        <p>{t("ブラウザやGPUの対応状況により、利用できる機能や性能が異なる場合があります。")}</p>
        <p>{t("重要な編集内容は定期的にプロジェクトファイルへ保存してください。")}</p>
        <br />
        <p>{t("商用・非商用を問わず制作に利用できます。")}</p>
        <p>{t("読み込む素材、フォント、拡張機能については各配布元の利用条件を確認してください。")}</p>
        <p>{t("詳しいライセンス条件はリポジトリのLICENSEを参照してください。")}</p>
      </div>
    </section>

    <hr />
    <footer className="about-footer">
      <p>{t("リンクはフリーですのでご自由にどうぞ。")}</p>
      <p>version 0.1.0<br />Web Edition<br />2026/10/11</p>
      <p>by <a href={REPOSITORY_URL}>GfxUtl contributors</a></p>
      <a href="/">{t("GfxUtlを起動")}</a>
    </footer>
  </main>;
}
