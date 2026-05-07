# Gravity Watch Party

Gravity の `https://www.gravity.place/share/ugcGame?id=...` ローダーから読み込む想定の YouTube ウォッチパーティ MVP です。Gravity内の縦画面 iPhone で遊ぶ前提にしています。

## できること

- YouTube URL の読み込み
- 再生、一時停止、シーク位置の同期
- ルームチャット
- Gravity ローダー内では `AgentSDK.user.getMyUserInfo` から表示名、アイコン、ユーザーIDを取得
- Gravity ローダー内では `AgentSDK.room.*` を使ってルームメッセージを同期
- 縦画面 iPhone 向けの1画面UI
- ローカル開発時だけ Node + WebSocket にフォールバック

## ローカル起動

```bash
npm install
npm start
```

起動後、`http://localhost:3000` を開きます。

## GitHub Pages 配置

GitHub Pages では Node サーバーは動かないため、リポジトリ直下の `index.html` / `app.js` / `styles.css` を静的サイトとして配信します。Gravity 内ではローダーの `game_file_url` に GitHub Pages の `index.html` URL を設定してください。

Gravity ルームがある招待URLから開かれた場合は自動参加します。通常起動の場合は、画面右上の共有ボタンで Gravity ルームを作成して招待します。

## Gravity ローダー連携

スマグラと同じローダーブリッジ形式に合わせています。

- ユーザー情報: `window.top.postMessage({ type: "API", action, requestId, params }, "*")`
- ユーザー情報の応答: `API_CALLBACK`
- ルーム操作: `window.parent.postMessage({ action, actionId, actionld, ...params }, "*")`
- ルーム応答: `gravityroomresponse` / `gravity_room_response`
- ルームイベント: `gravityroomevent` / `gravity_room_event`

ローカル開発時だけ WebSocket にフォールバックします。
