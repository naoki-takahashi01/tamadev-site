# たまナビ API

Cloudflare WorkerからOpenAI Responses APIを呼び出す、多摩.dev AI案内人のバックエンドです。

## 費用を止める仕組み

D1のカウンターを使い、次のいずれかへ到達した時点でOpenAI APIを呼ばず、HTTP 429と「本日の案内を終了しました」を返します。

- 1 IPアドレスあたり1日10回
- サイト全体で1日100回
- サイト全体で1か月300回

IPアドレスそのものは保存せず、`RATE_LIMIT_SALT`を加えたSHA-256ハッシュだけを保存します。上限値は`wrangler.toml`で変更できます。

## 初回セットアップ

```sh
cd worker
npm install
npx wrangler login
npx wrangler d1 create tamadev-ai
```

表示されたD1の`database_id`を`wrangler.toml`へ設定し、テーブルを作成します。

```sh
npx wrangler d1 execute tamadev-ai --remote --file=./schema.sql
npx wrangler secret put OPENAI_API_KEY
npx wrangler secret put RATE_LIMIT_SALT
npm run deploy
```

デプロイ後に表示された`https://...workers.dev/chat`を、トップページの`chat.js`読み込みタグにある`data-api-endpoint`へ設定してください。

## ローカル開発

`.dev.vars.example`を`.dev.vars`へコピーして値を設定し、ローカルD1へスキーマを適用します。

```sh
npx wrangler d1 execute tamadev-ai --local --file=./schema.sql
npm run dev
```

別ターミナルでサイトを配信します。

```sh
python3 -m http.server 8000
```

ローカル確認時はトップページの`data-api-endpoint`を`http://localhost:8787/chat`へ一時的に変更します。APIキーや`.dev.vars`はGitへ追加しないでください。

## 検索データの更新

イベントページを更新したら、リポジトリのルートで次を実行します。

```sh
node scripts/build-ai-knowledge.js
```

`ai/knowledge.json`へイベント、登壇者、登壇タイトル、公開資料URLが再生成されます。
