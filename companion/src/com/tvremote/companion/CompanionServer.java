package com.tvremote.companion;

import android.content.Context;
import android.os.SystemClock;
import android.util.Log;

import java.io.BufferedReader;
import java.io.IOException;
import java.io.InputStreamReader;
import java.io.OutputStreamWriter;
import java.io.PrintWriter;
import java.net.InetAddress;
import java.net.InetSocketAddress;
import java.net.ServerSocket;
import java.net.Socket;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.Collections;
import java.util.List;

/**
 * Line-oriented TCP server, LOOPBACK ONLY, and behind an HMAC handshake.
 *
 * Two layers, and neither is optional:
 *
 *   1. The bind is `InetAddress.getLoopbackAddress()`, not the wildcard address. The
 *      device's own 127.0.0.1 is the only place this listens, so nothing on the LAN
 *      can reach the port at all; the client gets to it through `adb forward`, which
 *      adb binds to 127.0.0.1 on the host. (This used to bind every interface, which
 *      let any device on the LAN type into the TV's focused field.)
 *   2. Loopback is not a permission: another app on the same TV can dial 127.0.0.1.
 *      So the FIRST thing on every connection is a handshake, before any verb is read:
 *
 *        server -> {"ok":true,"auth":"nonce","nonce":"<16 random bytes, hex>"}
 *        client -> AUTH <hmac-sha256(secret, nonceHex) as hex>
 *
 *      The secret itself never crosses the socket - it is provisioned over adb and
 *      stored in MODE_PRIVATE SharedPreferences (CompanionSecret). A wrong or missing
 *      AUTH gets no further reply and no verb runs: the socket is closed in
 *      authenticate(), before the command loop is entered. With NO secret stored the
 *      server answers {"ok":false,"error":"no_secret"} and closes - fail closed, so an
 *      unprovisioned companion is usable by nobody rather than by everybody.
 *
 * Frame after the handshake is unchanged: one JSON line out per command line in, many
 * commands per connection, a thread per connection.
 */
public final class CompanionServer {
    private final Context context;
    private final int port;
    private final String version;
    private final long startedAt = SystemClock.elapsedRealtime();
    private final List<Thread> clients = Collections.synchronizedList(new ArrayList<Thread>());

    /** Lowercase hex, or null when no secret is provisioned. Volatile: set at runtime. */
    private volatile String secret;

    private ServerSocket socket;
    private Thread acceptor;
    private volatile boolean stopped;

    public CompanionServer(Context context, int port, String version, String secretHex) {
        this.context = context;
        this.port = port;
        this.version = version;
        this.secret = secretHex;
    }

    /** Only ever the application context: it outlives the service, and nothing here holds a UI. */
    public Context context() {
        return context;
    }

    public int port() {
        return port;
    }

    public String version() {
        return version;
    }

    public long uptimeMs() {
        return SystemClock.elapsedRealtime() - startedAt;
    }

    /** True when a secret is provisioned: without one every connection is refused. */
    public boolean paired() {
        return secret != null && !secret.isEmpty();
    }

    /**
     * Provision (or clear, with null) the secret of the RUNNING server. Provisioning
     * over adb arrives as an intent extra, which can land on an already-started
     * service: no restart, and no window where the old secret still works.
     */
    public void setSecret(String secretHex) {
        this.secret = secretHex;
        Log.i(CompanionService.TAG, paired() ? "auth secret set" : "auth secret cleared");
    }

    /** Binds and starts accepting. Throws if the port is taken or the bind is refused. */
    public void start() throws IOException {
        ServerSocket s = new ServerSocket();
        s.setReuseAddress(true);
        // Loopback only: the LAN is not an interface this app ever answers on.
        s.bind(new InetSocketAddress(InetAddress.getLoopbackAddress(), port));
        socket = s;
        acceptor = new Thread(new Runnable() {
            @Override public void run() {
                acceptLoop();
            }
        }, "companion-accept");
        acceptor.setDaemon(true);
        acceptor.start();
        Log.i(CompanionService.TAG, "listening on " + s.getInetAddress().getHostAddress() + ":" + port
                + (paired() ? " (paired)" : " (no secret: refusing every connection)"));
    }

    public void stop() {
        stopped = true;
        try {
            if (socket != null) {
                socket.close();
            }
        } catch (IOException ignored) {
            // closing a listening socket we already closed
        }
        if (acceptor != null) {
            acceptor.interrupt();
        }
    }

    private void acceptLoop() {
        while (!stopped) {
            try {
                Socket client = socket.accept();
                client.setTcpNoDelay(true);
                Thread t = new Thread(new Runnable() {
                    private final Socket c = client;

                    @Override public void run() {
                        serve(c);
                    }
                }, "companion-client");
                t.setDaemon(true);
                t.start();
                clients.add(t);
            } catch (IOException e) {
                if (!stopped) {
                    Log.w(CompanionService.TAG, "accept failed: " + e);
                }
            }
        }
    }

    private void serve(Socket client) {
        try (Socket c = client;
             BufferedReader in = new BufferedReader(
                     new InputStreamReader(c.getInputStream(), StandardCharsets.UTF_8));
             PrintWriter out = new PrintWriter(
                     new OutputStreamWriter(c.getOutputStream(), StandardCharsets.UTF_8))) {
            if (!authenticate(in, out)) {
                return;
            }
            String line;
            while ((line = in.readLine()) != null) {
                out.print(Protocol.dispatch(line, this));
                out.print('\n');
                out.flush();
            }
        } catch (IOException e) {
            Log.w(CompanionService.TAG, "connection ended: " + e);
        } finally {
            clients.remove(Thread.currentThread());
        }
    }

    /**
     * The handshake. Returns true only when the peer proved it knows the secret; on
     * every other path it has already closed the connection and NO verb is read.
     *
     * Nothing here logs the secret, the nonce's HMAC, or what the peer sent: a wrong
     * answer is logged as a refusal, with no value from either side of the compare.
     */
    private boolean authenticate(BufferedReader in, PrintWriter out) throws IOException {
        String current = this.secret;
        if (current == null || current.isEmpty()) {
            // Fail closed: no secret means no client, including a correct one.
            out.print(Json.obj()
                    .putBool("ok", false)
                    .putStr("cmd", "auth")
                    .putStr("error", "no_secret")
                    .putStr("detail", "no secret provisioned on the TV; pair it over adb first")
                    .done());
            out.print('\n');
            out.flush();
            return false;
        }

        String nonce = CompanionSecret.randomHex(16);
        out.print(Json.obj()
                .putBool("ok", true)
                .putStr("cmd", "auth")
                .putStr("auth", "nonce")
                .putStr("nonce", nonce)
                .done());
        out.print('\n');
        out.flush();

        String line = in.readLine();
        if (line == null) {
            Log.w(CompanionService.TAG, "client hung up during the handshake");
            return false;
        }
        String answer = line.trim();
        if (!answer.regionMatches(true, 0, "AUTH ", 0, 5)) {
            Log.w(CompanionService.TAG, "refused a connection: no AUTH line");
            return false;
        }
        String expected = CompanionSecret.hmacHex(current, nonce);
        if (!CompanionSecret.matches(expected, answer.substring(5).trim())) {
            Log.w(CompanionService.TAG, "refused a connection: wrong secret");
            return false;
        }
        return true;
    }
}
