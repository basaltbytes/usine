---
"@usine/server": patch
---

The server compresses the web UI's files and the operator API's JSON responses with Brotli or gzip when the request accepts it. The build writes Brotli and gzip copies of the web UI's text files, and the server sends the copy that the request accepts. JSON responses of 1,024 bytes or more are compressed when they are sent. Conditional reads return a weak `ETag` that holds for every encoding. Event streams and `Cache-Control: no-store` responses stay uncompressed.
