import { Algorithm, hash } from "@node-rs/argon2";

// Prefer stdin so the password doesn't land in shell history:
//   printf '%s' 'the-password' | node scripts/hash-password.mjs
async function readStdin() {
  if (process.stdin.isTTY) return "";
  let text = "";
  for await (const chunk of process.stdin) text += chunk;
  return text.replace(/\r?\n$/, "");
}

const password = process.argv[2] ?? (await readStdin());
if (password.length === 0) {
  console.error("Usage: printf '%s' '<password>' | node scripts/hash-password.mjs");
  process.exit(1);
}

const hashed = await hash(password, {
  algorithm: Algorithm.Argon2id,
  memoryCost: 19456,
  timeCost: 2,
  parallelism: 1,
});
process.stdout.write(`${hashed}\n`);
