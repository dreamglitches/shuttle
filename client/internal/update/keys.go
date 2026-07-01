package update

import "crypto/ed25519"

// UpdatePublicKey is the ed25519 public key used to verify signed updates.
// This key is compiled into the binary and NEVER fetched from the manager.
// A compromised manager cannot substitute a different key.
//
// To generate a new keypair:
//   openssl genpkey -algorithm Ed25519 -out update_private.pem
//   openssl pkey -in update_private.pem -pubout -out update_public.pem
//   openssl pkey -in update_public.pem -pubin -outform DER | tail -c 32 | xxd -i
//
// Replace the bytes below with the 32-byte raw public key from your keypair.
// Keep update_private.pem OFFLINE — it should never touch the manager or any server.
//
// PLACEHOLDER: replace with your actual public key bytes before first release build.
var UpdatePublicKey = ed25519.PublicKey([]byte{
	// 32 bytes — placeholder zeros, MUST be replaced before building
	0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
	0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
	0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
	0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
})
