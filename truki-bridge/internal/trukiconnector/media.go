// Copyright 2026 Truki
// SPDX-License-Identifier: AGPL-3.0-only

package trukiconnector

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"regexp"
	"strings"

	"maunium.net/go/mautrix/bridgev2"
	"maunium.net/go/mautrix/bridgev2/networkid"
	"maunium.net/go/mautrix/event"
	"maunium.net/go/mautrix/id"
)

// directMediaPrefix marks content URIs that stand for a network media ID
// (GenerateContentURI) rather than a file in the media directory.
const directMediaPrefix = "direct-"

var mediaHashRegex = regexp.MustCompile(`^[0-9a-f]{64}$`)

var (
	// ErrBadMediaURI means a media ID is not a parseable mxc:// URI.
	ErrBadMediaURI = errors.New("not a parseable mxc URI")
	// ErrNotLocalMedia means a content URI parses but names nothing in the
	// local media store: a different homeserver, or a file ID that is not
	// a sha256 hex digest.
	ErrNotLocalMedia = errors.New("content URI is not Truki local media")
)

// mediaPath resolves an mxc://truki.local/<sha256 hex> URI to its file.
// Anything else is rejected, so a URI can never name a path outside mediaDir.
func (c *Connector) mediaPath(uri id.ContentURIString) (string, error) {
	parsed, err := uri.Parse()
	if err != nil {
		return "", fmt.Errorf("%w: %w", ErrBadMediaURI, err)
	}
	if parsed.Homeserver != ServerName || !mediaHashRegex.MatchString(parsed.FileID) {
		return "", fmt.Errorf("%w: %q", ErrNotLocalMedia, uri)
	}
	return filepath.Join(c.mediaDir, parsed.FileID), nil
}

// MediaPath resolves uri to its file in mediaDir, applying the same
// validation as the connector's own media handling: only
// mxc://truki.local/<sha256 hex> URIs are accepted, so a URI can never
// name a path outside mediaDir. ErrBadMediaURI means uri is not a
// parseable mxc URI; ErrNotLocalMedia that it names no local media file.
func MediaPath(mediaDir string, uri id.ContentURIString) (string, error) {
	return (&Connector{mediaDir: mediaDir}).mediaPath(uri)
}

func mediaURI(sum []byte) id.ContentURIString {
	return id.ContentURI{Homeserver: ServerName, FileID: hex.EncodeToString(sum)}.CUString()
}

// storeMediaFile moves tmpPath into the media directory under its hash.
func (c *Connector) storeMediaFile(tmpPath string) (id.ContentURIString, error) {
	f, err := os.Open(tmpPath)
	if err != nil {
		return "", err
	}
	h := sha256.New()
	_, err = io.Copy(h, f)
	_ = f.Close()
	if err != nil {
		return "", err
	}
	sum := h.Sum(nil)
	if err := os.Rename(tmpPath, filepath.Join(c.mediaDir, hex.EncodeToString(sum))); err != nil {
		return "", err
	}
	return mediaURI(sum), nil
}

func (c *Connector) createMediaTemp() (*os.File, error) {
	if err := os.MkdirAll(c.mediaDir, 0o700); err != nil {
		return nil, err
	}
	return os.CreateTemp(c.mediaDir, ".upload-*")
}

func (i *intent) UploadMedia(_ context.Context, _ id.RoomID, data []byte, _, _ string) (id.ContentURIString, *event.EncryptedFileInfo, error) {
	tmp, err := i.c.createMediaTemp()
	if err != nil {
		return "", nil, err
	}
	defer os.Remove(tmp.Name())
	_, err = tmp.Write(data)
	if closeErr := tmp.Close(); err == nil {
		err = closeErr
	}
	if err != nil {
		return "", nil, err
	}
	uri, err := i.c.storeMediaFile(tmp.Name())
	return uri, nil, err
}

func (i *intent) UploadMediaStream(_ context.Context, _ id.RoomID, _ int64, _ bool, cb bridgev2.FileStreamCallback) (id.ContentURIString, *event.EncryptedFileInfo, error) {
	tmp, err := i.c.createMediaTemp()
	if err != nil {
		return "", nil, err
	}
	defer os.Remove(tmp.Name())
	res, err := cb(tmp)
	if closeErr := tmp.Close(); err == nil {
		err = closeErr
	}
	if err != nil {
		return "", nil, bridgev2.CallbackError{Type: "write", Wrapped: err}
	}
	src := tmp.Name()
	if res != nil && res.ReplacementFile != "" {
		src = res.ReplacementFile
		defer os.Remove(src)
	}
	uri, err := i.c.storeMediaFile(src)
	if err != nil && src != tmp.Name() {
		// A replacement file may live on another filesystem; copy it in.
		uri, err = i.copyIntoMedia(src)
	}
	return uri, nil, err
}

func (i *intent) copyIntoMedia(src string) (id.ContentURIString, error) {
	data, err := os.ReadFile(src)
	if err != nil {
		return "", err
	}
	uri, _, err := i.UploadMedia(context.Background(), "", data, "", "")
	return uri, err
}

func (i *intent) DownloadMedia(_ context.Context, uri id.ContentURIString, file *event.EncryptedFileInfo) ([]byte, error) {
	if file != nil {
		uri = file.URL
	}
	path, err := i.c.mediaPath(uri)
	if err != nil {
		return nil, err
	}
	data, err := os.ReadFile(path)
	if err != nil {
		return nil, err
	}
	if file != nil {
		if err := file.DecryptInPlace(data); err != nil {
			return nil, err
		}
	}
	return data, nil
}

func (i *intent) DownloadMediaToFile(ctx context.Context, uri id.ContentURIString, file *event.EncryptedFileInfo, writable bool, callback func(*os.File) error) error {
	if file == nil && !writable {
		path, err := i.c.mediaPath(uri)
		if err != nil {
			return err
		}
		f, err := os.Open(path)
		if err != nil {
			return err
		}
		defer f.Close()
		if err := callback(f); err != nil {
			return bridgev2.CallbackError{Type: "read", Wrapped: err}
		}
		return nil
	}
	// The callback may modify the file, or the content must be decrypted:
	// hand it a private temporary copy.
	data, err := i.DownloadMedia(ctx, uri, file)
	if err != nil {
		return err
	}
	tmp, err := os.CreateTemp("", "truki-download-*")
	if err != nil {
		return err
	}
	defer func() {
		_ = tmp.Close()
		_ = os.Remove(tmp.Name())
	}()
	if _, err := io.Copy(tmp, bytes.NewReader(data)); err != nil {
		return err
	}
	if _, err := tmp.Seek(0, io.SeekStart); err != nil {
		return err
	}
	if err := callback(tmp); err != nil {
		return bridgev2.CallbackError{Type: "read", Wrapped: err}
	}
	return nil
}

// GenerateContentURI maps a network media ID to mxc://truki.local/direct-<b64>.
func (c *Connector) GenerateContentURI(_ context.Context, mediaID networkid.MediaID) (id.ContentURIString, error) {
	return id.ContentURI{
		Homeserver: ServerName,
		FileID:     directMediaPrefix + base64.RawURLEncoding.EncodeToString(mediaID),
	}.CUString(), nil
}

// ParseContentURI is the inverse of GenerateContentURI. Any other URI,
// including local uploads and other servers, is an error.
func (c *Connector) ParseContentURI(_ context.Context, uri id.ContentURIString) (networkid.MediaID, error) {
	parsed, err := uri.Parse()
	if err != nil {
		return nil, fmt.Errorf("failed to parse content URI: %w", err)
	}
	encoded, ok := strings.CutPrefix(parsed.FileID, directMediaPrefix)
	if parsed.Homeserver != ServerName || !ok {
		return nil, fmt.Errorf("content URI %q is not Truki direct media", uri)
	}
	mediaID, err := base64.RawURLEncoding.DecodeString(encoded)
	if err != nil {
		return nil, fmt.Errorf("invalid direct media ID in %q: %w", uri, err)
	}
	return networkid.MediaID(mediaID), nil
}
