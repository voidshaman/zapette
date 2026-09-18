package com.tvremote.companion;

import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;
import android.util.Log;

/**
 * Starts the companion after boot. API 30 forbids starting a foreground service
 * from the background for target-30 apps - receiving BOOT_COMPLETED is one of the
 * named exemptions, which is the whole reason this receiver exists.
 */
public class BootReceiver extends BroadcastReceiver {
    @Override
    public void onReceive(Context context, Intent intent) {
        String action = intent == null ? null : intent.getAction();
        Log.i(CompanionService.TAG, "boot receiver: " + action);
        if (!Intent.ACTION_BOOT_COMPLETED.equals(action)) {
            return;
        }
        try {
            context.startForegroundService(new Intent(context, CompanionService.class));
        } catch (Throwable t) {
            Log.e(CompanionService.TAG, "boot start failed", t);
        }
    }
}
