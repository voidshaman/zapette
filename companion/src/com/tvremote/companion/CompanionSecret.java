package com.tvremote.companion;

import android.content.Context;
import android.content.SharedPreferences;
import android.util.Log;

import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.security.SecureRandom;

import javax.crypto.Mac;
import javax.crypto.spec.SecretKeySpec;

/**
 * The per-device secret every connection has to prove it knows, and the HMAC that
 * proves it.
 *
 * The trust root is adb: the secret only ever arrives as an intent extra on a
 * `am start-foreground-service` over the (already RSA-authenticated) adb link, is
 * persisted in a MODE_PRIVATE SharedPreferences file, and is NEVER written to the
 * log, to a notification, or to any verb reply. It does not travel over the socket
 * in either direction - the socket carries a fresh random nonce and an HMAC of it.
 *
 * Storage is the whole state: no secret means the server accepts nothing at all
 * (see CompanionServer.authenticate), so an unprovisioned companion is unusable by
 * anyone, including us, until one is written.
 */
final class CompanionSecret {
    private static final String PREFS = "companion_auth";
    private static final String FIELD = "secret_hex";

    /** 16 random bytes: the smallest nonce/secret size this build will accept. */
    private static final int MIN_HEX_CHARS = 32;

    private CompanionSecret() {}

    /** The stored secret as lowercase hex, or null when none is stored. */
    static String get(Context context) {
        try {
            String v = prefs(context).getString(FIELD, null);
            return normalize(v);
        } catch (Throwable t) {
            Log.w(CompanionService.TAG, "secret unreadable: " + t);
            return null;
        }
    }

    /** Store a secret from its hex form. Returns the stored form, or null if refused. */
    static String set(Context context, String hex) {
        String normalized = normalize(hex);
        if (normalized == null) {
            return null;
        }
        prefs(context).edit().putString(FIELD, normalized).commit();
        return normalized;
    }

    static void clear(Context context) {
        prefs(context).edit().remove(FIELD).commit();
    }

    /** Lowercase hex, or null when the value is not a usable secret. */
    private static String normalize(String value) {
        if (value == null) {
            return null;
        }
        String v = value.trim().toLowerCase(java.util.Locale.US);
        if (v.length() < MIN_HEX_CHARS || (v.length() % 2) != 0) {
            return null;
        }
        for (int i = 0; i < v.length(); i++) {
            char c = v.charAt(i);
            boolean hex = (c >= '0' && c <= '9') || (c >= 'a' && c <= 'f');
            if (!hex) {
                return null;
            }
        }
        return v;
    }

    /**
     * HMAC-SHA256(secret, nonceHex), lowercase hex - key is the decoded secret
     * bytes, message is the nonce exactly as the client received it (hex, ASCII).
     * Both sides fix those two choices here and in src/companion.mjs.
     */
    static String hmacHex(String secretHex, String message) {
        try {
            byte[] key = hexToBytes(secretHex);
            if (key == null) {
                return null;
            }
            Mac mac = Mac.getInstance("HmacSHA256");
            mac.init(new SecretKeySpec(key, "HmacSHA256"));
            return bytesToHex(mac.doFinal(message.getBytes(StandardCharsets.UTF_8)));
        } catch (Throwable t) {
            // A failure here must never fall through to "accepted".
            Log.w(CompanionService.TAG, "hmac failed: " + t);
            return null;
        }
    }

    /** Constant-time compare of two hex strings (MessageDigest.isEqual on their bytes). */
    static boolean matches(String expectedHex, String candidateHex) {
        if (expectedHex == null || candidateHex == null) {
            return false;
        }
        byte[] a = expectedHex.getBytes(StandardCharsets.UTF_8);
        byte[] b = candidateHex.getBytes(StandardCharsets.UTF_8);
        return MessageDigest.isEqual(a, b);
    }

    static String randomHex(int bytes) {
        byte[] buf = new byte[bytes];
        new SecureRandom().nextBytes(buf);
        return bytesToHex(buf);
    }

    static String bytesToHex(byte[] bytes) {
        StringBuilder b = new StringBuilder(bytes.length * 2);
        for (byte x : bytes) {
            b.append(Character.forDigit((x >> 4) & 0xf, 16)).append(Character.forDigit(x & 0xf, 16));
        }
        return b.toString();
    }

    private static byte[] hexToBytes(String hex) {
        if (hex == null || (hex.length() % 2) != 0) {
            return null;
        }
        byte[] out = new byte[hex.length() / 2];
        for (int i = 0; i < out.length; i++) {
            int hi = Character.digit(hex.charAt(i * 2), 16);
            int lo = Character.digit(hex.charAt(i * 2 + 1), 16);
            if (hi < 0 || lo < 0) {
                return null;
            }
            out[i] = (byte) ((hi << 4) | lo);
        }
        return out;
    }

    private static SharedPreferences prefs(Context context) {
        return context.getSharedPreferences(PREFS, Context.MODE_PRIVATE);
    }
}
