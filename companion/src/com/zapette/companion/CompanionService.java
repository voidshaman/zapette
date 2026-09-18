package com.zapette.companion;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.app.Service;
import android.content.Intent;
import android.content.pm.ServiceInfo;
import android.os.IBinder;
import android.util.Log;

/**
 * Foreground service owning the socket server: it has to outlive the activity,
 * and a foreground service is the only thing Android 11 lets live that long.
 * START_STICKY so the system restarts it if the process is reaped.
 */
public class CompanionService extends Service {
    public static final String TAG = "zapette";

    /**
     * 7878 (the port this was designed around) is already listening on the TV:
     * /proc/net/tcp shows a root-owned LISTEN on 0.0.0.0:7878 that accepts a LAN
     * connection and closes it without a reply. 7900 is free, and below Android's
     * ip_local_port_range (32768+) so no client can steal it as an ephemeral port.
     */
    public static final int PORT = 7900;

    /**
     * Provisioning, over adb and only over adb: the secret rides an intent extra on
     * `am start-foreground-service -n com.zapette.companion/.CompanionService
     * --es companion_secret <hex>`, which is already authenticated (RSA + the TV's
     * on-screen confirmation) and never crosses the command socket. It is stored in
     * MODE_PRIVATE SharedPreferences and never logged, notified or echoed in a reply.
     */
    public static final String EXTRA_SECRET = "companion_secret";
    /** The un-pairing intent extra: `--ez companion_forget_secret true`. */
    public static final String EXTRA_FORGET = "companion_forget_secret";

    private static final String CHANNEL_ID = "companion";
    private static final int NOTIF_ID = 7878;

    /** Read by MainActivity for its status line. */
    static volatile boolean running = false;
    static volatile boolean paired = false;
    static volatile String lastError = null;

    private CompanionServer server;

    @Override
    public void onCreate() {
        super.onCreate();
        createChannel();
        startForeground(NOTIF_ID, buildNotification("Starting socket server"), 
                ServiceInfo.FOREGROUND_SERVICE_TYPE_CONNECTED_DEVICE);
        startServer();
    }

    @Override
    public int onStartCommand(Intent intent, int flags, int startId) {
        provision(intent);
        if (!running) {
            startServer();
        }
        return START_STICKY;
    }

    /**
     * Apply a provisioning intent, on a running service or a fresh one.
     *
     * `companion_secret` (non-empty) writes the secret into MODE_PRIVATE prefs and hands
     * it to the live server, so a provisioned companion starts accepting immediately and
     * a re-provisioned one stops accepting the old secret in the same call. An empty
     * `companion_secret`, or `companion_forget_secret true`, clears it - which also takes
     * the server back to refusing EVERY connection (fail closed). Nothing here logs the
     * value: only whether a secret is now set.
     */
    private void provision(Intent intent) {
        if (intent == null) {
            return;
        }
        boolean forget = intent.getBooleanExtra(EXTRA_FORGET, false);
        if (!forget && !intent.hasExtra(EXTRA_SECRET)) {
            return;
        }
        if (forget) {
            CompanionSecret.clear(this);
            if (server != null) server.setSecret(null);
            paired = false;
            updateNotification("Unauthenticated: refusing every connection");
            Log.i(TAG, "secret cleared");
            return;
        }
        String hex = CompanionSecret.set(this, intent.getStringExtra(EXTRA_SECRET));
        if (hex == null) {
            // Refused: keep whatever was stored before rather than ending up unpaired by accident.
            Log.w(TAG, "provisioning refused: not a usable secret (expected hex, >= 16 bytes)");
            return;
        }
        if (server != null) server.setSecret(hex);
        paired = true;
        updateNotification("Listening on loopback tcp/" + PORT + " (paired)");
        Log.i(TAG, "secret provisioned: " + (hex.length() / 2) + " bytes");
    }

    @Override
    public void onDestroy() {
        if (server != null) {
            server.stop();
        }
        running = false;
        super.onDestroy();
    }

    @Override
    public IBinder onBind(Intent intent) {
        return null;
    }

    private void startServer() {
        if (server != null) {
            return;
        }
        String version = "0";
        try {
            version = getPackageManager().getPackageInfo(getPackageName(), 0).versionName;
        } catch (Exception e) {
            Log.w(TAG, "versionName unavailable: " + e);
        }
        try {
            // The secret is state on the device, not state in this process: a restart
            // (boot, START_STICKY, an adb start) comes back paired, and a process that
            // has never been provisioned comes back refusing everything.
            String secret = CompanionSecret.get(getApplicationContext());
            CompanionServer s = new CompanionServer(getApplicationContext(), PORT, version, secret);
            s.start();
            server = s;
            running = true;
            paired = s.paired();
            lastError = null;
            updateNotification(
                    paired
                            ? "Listening on loopback tcp/" + PORT + " (paired)"
                            : "No secret: refusing every connection (pair over adb)");
        } catch (Throwable t) {
            running = false;
            paired = false;
            lastError = t.toString();
            Log.e(TAG, "socket server failed to start", t);
            updateNotification("Socket failed: " + t);
        }
    }

    private void createChannel() {
        NotificationManager nm = getSystemService(NotificationManager.class);
        if (nm.getNotificationChannel(CHANNEL_ID) == null) {
            NotificationChannel ch = new NotificationChannel(CHANNEL_ID, "Companion",
                    NotificationManager.IMPORTANCE_LOW);
            ch.setDescription("Zapette Companion command socket");
            nm.createNotificationChannel(ch);
        }
    }

    private Notification buildNotification(String text) {
        PendingIntent pi = PendingIntent.getActivity(this, 0, new Intent(this, MainActivity.class),
                PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);
        return new Notification.Builder(this, CHANNEL_ID)
                .setSmallIcon(android.R.drawable.stat_notify_sync)
                .setContentTitle("Zapette Companion")
                .setContentText(text)
                .setOngoing(true)
                .setContentIntent(pi)
                .build();
    }

    private void updateNotification(String text) {
        NotificationManager nm = getSystemService(NotificationManager.class);
        nm.notify(NOTIF_ID, buildNotification(text));
    }
}
