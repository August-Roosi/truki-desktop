// Copyright 2026 Truki
// SPDX-License-Identifier: AGPL-3.0-only

package trukiconnector

import (
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"strings"

	"maunium.net/go/mautrix/bridgev2/database"
	"maunium.net/go/mautrix/bridgev2/networkid"
	"maunium.net/go/mautrix/id"
)

// ServerName is the fake homeserver domain every local ID lives on.
const ServerName = "truki.local"

var (
	// LocalUser is the single local Matrix user: the bridge admin and the
	// owner of every login.
	LocalUser = id.UserID("@me:" + ServerName)
	// BotMXID is the bridge bot. Its sends are stored like any other.
	BotMXID = id.UserID("@truki-bot:" + ServerName)
)

// ghostPrefix is the localpart prefix of this network's ghosts.
func (c *Connector) ghostPrefix() string {
	return c.network + "_"
}

// FormatGhostMXID returns @<network>_<escaped id>:truki.local.
func (c *Connector) FormatGhostMXID(userID networkid.UserID) id.UserID {
	return id.NewUserID(c.ghostPrefix()+id.EncodeUserLocalpart(string(userID)), ServerName)
}

// ParseGhostMXID is the inverse of FormatGhostMXID. It returns false for any
// MXID that is not one of this network's ghosts on truki.local.
func (c *Connector) ParseGhostMXID(userID id.UserID) (networkid.UserID, bool) {
	localpart, server, err := userID.Parse()
	if err != nil || server != ServerName {
		return "", false
	}
	escaped, ok := strings.CutPrefix(localpart, c.ghostPrefix())
	if !ok {
		return "", false
	}
	decoded, err := id.DecodeUserLocalpart(escaped)
	if err != nil {
		return "", false
	}
	return networkid.UserID(decoded), true
}

// hashParts hashes the parts with NUL separators so that no two different
// part lists produce the same input.
func hashParts(parts ...string) [sha256.Size]byte {
	h := sha256.New()
	for i, p := range parts {
		if i > 0 {
			h.Write([]byte{0})
		}
		h.Write([]byte(p))
	}
	var sum [sha256.Size]byte
	h.Sum(sum[:0])
	return sum
}

// eventIDFromHash returns $ + the first 43 base64url characters of the hash
// (43 characters is the full unpadded encoding of 32 bytes).
func eventIDFromHash(sum [sha256.Size]byte) id.EventID {
	return id.EventID("$" + base64.RawURLEncoding.EncodeToString(sum[:])[:43])
}

// formatUUID formats 16 bytes as a UUID string with the given version nibble.
func formatUUID(b [16]byte, version byte) string {
	b[6] = b[6]&0x0f | version<<4
	b[8] = b[8]&0x3f | 0x80 // RFC 4122 variant
	h := hex.EncodeToString(b[:])
	return h[0:8] + "-" + h[8:12] + "-" + h[12:16] + "-" + h[16:20] + "-" + h[20:32]
}

func roomIDFromUUID(uuid string) id.RoomID {
	return id.RoomID("!" + uuid + ":" + ServerName)
}

// newRoomID returns a random !<uuid v4>:truki.local.
func newRoomID() id.RoomID {
	var b [16]byte
	_, _ = rand.Read(b[:])
	return roomIDFromUUID(formatUUID(b, 4))
}

// newEventID returns a random event ID in the same shape as the
// deterministic ones.
func newEventID() id.EventID {
	var sum [sha256.Size]byte
	_, _ = rand.Read(sum[:])
	return eventIDFromHash(sum)
}

// txnEventID derives the event ID of a send with a transaction ID, so a
// retried send dedups the way a homeserver does.
func txnEventID(room id.RoomID, sender id.UserID, txnID string) id.EventID {
	return eventIDFromHash(hashParts("txn", string(room), string(sender), txnID))
}

// GenerateDeterministicRoomID returns !<uuid>:truki.local, where the UUID
// (version 8) is derived from the portal key.
func (c *Connector) GenerateDeterministicRoomID(key networkid.PortalKey) id.RoomID {
	sum := hashParts("room", string(key.ID), string(key.Receiver))
	var b [16]byte
	copy(b[:], sum[:16])
	return roomIDFromUUID(formatUUID(b, 8))
}

// GenerateDeterministicEventID hashes the room, portal key, message and part.
func (c *Connector) GenerateDeterministicEventID(roomID id.RoomID, key networkid.PortalKey, messageID networkid.MessageID, partID networkid.PartID) id.EventID {
	return eventIDFromHash(hashParts(string(roomID), string(key.ID), string(key.Receiver), string(messageID), string(partID)))
}

// GenerateReactionEventID is deterministic so a replayed backfill does not
// store a reaction twice. Without a target message it is random.
//
// It is also random without an emoji ID. Networks that allow one reaction
// per user (WhatsApp) leave EmojiID empty and carry the emoji only in the
// event content, which bridgev2's interface does not pass here, so a
// deterministic ID would hash a changed reaction to the old reaction's ID
// and the store would drop it as a duplicate. Only replay dedup of such
// reactions is lost.
func (c *Connector) GenerateReactionEventID(roomID id.RoomID, target *database.Message, sender networkid.UserID, emojiID networkid.EmojiID) id.EventID {
	if target == nil || emojiID == "" {
		return newEventID()
	}
	return eventIDFromHash(hashParts("reaction", string(roomID), string(target.Room.ID), string(target.Room.Receiver),
		string(target.ID), string(target.PartID), string(sender), string(emojiID)))
}
