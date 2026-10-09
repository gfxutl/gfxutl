# GfxUtl

ブラウザで動作するノンリニア動画編集ソフトウェアの初期実装です。

## 起動

```bash
npm install
npm run dev
```

本番ビルドは `npm run build` です。File System Access API、Local Font Access API、WebGPU、WebCodecsを利用するため、Chromium系ブラウザのHTTPSまたはlocalhost環境を推奨します。未対応機能は自動的にファイル入力、WebGL 2、通常フォントへフォールバックします。

## 構成

- `components/`: shadcnパターンの独立UIコンポーネント（メディア、プレビュー、インスペクタ、タイムライン等）
- `core/interface/`: 全コンポーネントを接続する状態・コマンド・MessageChannelクライアント・仮想タイムライン
- `core/protocol/`: UIとRendererの双方が参照できるstructured-clone可能な唯一の共有契約
- `core/runtime.ts`: 専用Workerを生成しUI側へ注入する唯一の合成ルート
- `core/engine/media.worker.ts`: MediaBunnyとThree.js WebGPURendererを実行する単一専用Worker
- `core/engine/ram-preview-cache.ts`: デフォルト有効・128 MiB固定上限のH.264 LRUキャッシュ
- `core/persistence/handle-project-store.ts`: `idb-keyval`によるFileSystemFileHandle単位の編集状態保存

メディア、プレビュー、インスペクタ、タイムラインの境界はドラッグでリサイズできます。境界をダブルクリックすると既定サイズへ戻り、調整値はブラウザへ保存されます。タイムラインには固定トラックがなく、各クリップはScratchのブロックのように時間と任意のY座標を持つ自由配置です。重なりも許可されます。通常は時間だけをフレームへスナップし、ドラッグ中にShiftを押すと一時的にスナップを解除します。

メディアカードはタイムラインキャンバスの任意位置へドラッグ＆ドロップできます。「出力」では解像度、コンテナ、映像・音声コーデック、各ビットレート、フレームレート、ファイル名を設定し、専用Worker上のThree.jsレンダー結果と音声ミックスをMediaBunnyでエンコードします。インスペクタの「メタデータ」には選択項目の実ファイル情報とタイムライン情報が表示されます。

Three.jsコアはBox、Capsule、Circle、Cone、Cylinder、各Polyhedron、Plane、Ring、Sphere、Torus、TorusKnot、Lathe、Shape、Extrude、Tube、Edges、Wireframeと任意BufferGeometryをstructured-clone可能な仕様から生成できます。MediaBunnyの`VideoSample.toVideoFrame()`が返す参照ハンドルを`THREE.VideoFrameTexture.setFrame()`へ直接設定し、ピクセルコピーを挟まず描画します。フレームは次のGPU描画完了後に明示的にcloseされます。

起動時にOffscreenCanvasとMessageChannelのポートをWorkerへ同時に移譲し、それ以降の要求・応答は専用ポートだけを通ります。`core/interface`と`core/engine`は相互にimportせず、`core/protocol`だけを共有します。タイムラインはメインスレッド上の保持型仮想ツリーで差分比較され、変更ノードと影響時間範囲だけがWorkerへ送られます。RAMプレビューもその範囲だけ破棄・先読み再エンコードされます。

停止中は現在位置をリアルタイム表示しつつ、その先をH.264 RAMプレビューへ低優先度で先読みします。再生中は同一フレームのキャッシュを優先的に復号表示します。各クリップは順序付きの効果スタックを持ち、変形、明るさ、色調、透明度を複数重ねられます。無地部分は常時存在する「背景オブジェクト」として選択・編集でき、プレビューCanvasは別ウィンドウへ移してから同じWorkerへ再接続し、編集画面へ戻せます。

ローカルメディアはFile/BlobをMediaBunnyの`BlobSource`へ渡し、2 MiBの読み取りキャッシュを介して必要範囲のみ解析します。UIは`body > div#main`を相対配置コンテナとし、各主要パネルを絶対配置しています。

起動時はテンプレートやデモ素材を読み込まず、空のタイムラインと白背景から開始します。独立したプロジェクトファイルは作らず、読み込んだFileSystemFileHandleごとに関連アセット、クリップ、効果スタックをIndexedDBへ保存・復元します。
