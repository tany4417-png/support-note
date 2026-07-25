# サポートノート 作業ルール

- **タニメモ（`dev/tanimemo`）のフォークですが別サービスです**。こちらの作業でタニメモ側のファイルを変更しないこと。
- **wrangler は `--config` に `worker/wrangler.jsonc` の絶対パスを渡す**。cwd 依存で C3 の自動セットアップが走り、別 Worker を勝手に作って設定ファイルを書き換えます。
- **cron を足さないこと**。無料枠は1アカウント5個で、通知は同期リクエスト内の即時プッシュでまかなう設計です。
- **D1 のスキーマを変えたら、デプロイより先に `npx wrangler d1 migrations apply support-note --remote`**。
- **GitHub の Public リポジトリです**。顧客名・実トークン・個人URLをコミットに入れないこと。実値は `.local` / `.dev.vars` 系の git 管理外ファイルへ。
