# Odd Signal & Pattern Party

Two original 2–8 player RendeChat puzzle races built on the shared room lobby and Cloudflare Durable Objects.

- **Odd Signal**: spot the item that does not belong in a set.
- **Pattern Party**: solve a short number-sequence puzzle before the shared timer expires.

Each match has eight shuffled rounds. Correct answers score 100 points, up to 40 speed points, and a streak bonus up to 40. Incorrect or expired answers score zero. Everyone sees each round's reveal and explanation before the next round. The server is authoritative for answers, scores, deadlines, and winners; clients reconnect using short-lived Worker tickets.
