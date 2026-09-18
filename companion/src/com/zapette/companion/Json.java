package com.zapette.companion;

import java.util.ArrayList;
import java.util.List;

/** Minimal flat-JSON writer. No dependency, no parser: replies are built, never read back. */
final class Json {
    private Json() {}

    static String str(String s) {
        if (s == null) {
            return "null";
        }
        StringBuilder b = new StringBuilder(s.length() + 2).append('"');
        for (int i = 0; i < s.length(); i++) {
            char c = s.charAt(i);
            switch (c) {
                case '"': b.append("\\\""); break;
                case '\\': b.append("\\\\"); break;
                case '\n': b.append("\\n"); break;
                case '\r': b.append("\\r"); break;
                case '\t': b.append("\\t"); break;
                default:
                    if (c < 0x20) {
                        b.append(String.format("\\u%04x", (int) c));
                    } else {
                        b.append(c);
                    }
            }
        }
        return b.append('"').toString();
    }

    static String num(long v) {
        return Long.toString(v);
    }

    static Obj obj() {
        return new Obj();
    }

    /** Alternating key / already-rendered-JSON-value pairs. */
    static final class Obj {
        private final List<String> parts = new ArrayList<>();

        Obj put(String key, String rawJsonValue) {
            parts.add(str(key) + ":" + rawJsonValue);
            return this;
        }

        Obj putStr(String key, String v) {
            return put(key, str(v));
        }

        Obj putNum(String key, long v) {
            return put(key, num(v));
        }

        Obj putBool(String key, boolean v) {
            return put(key, v ? "true" : "false");
        }

        String done() {
            return "{" + String.join(",", parts) + "}";
        }
    }
}
