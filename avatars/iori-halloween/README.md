# いおりのハロウィンの Slack アイコン

fork だけにある、季節もののアイコンです。`slack/<表情>.png` の 9 枚は、どれも同じ画像
（魔女の帽子のいおり、256×256 の PNG（RGB））です。表情の描き分けはありません。

サーバーの image には入れていません。Slack の `slack.avatarBaseUrl` をこのディレクトリの raw URL に
向けたインスタンスだけが使います。元に戻すときは `avatarBaseUrl` を `avatars/iori/slack` に戻します。
