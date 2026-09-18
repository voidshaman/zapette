package com.tvremote.companion;

import android.app.Activity;
import android.content.Intent;
import android.graphics.Color;
import android.os.Bundle;
import android.util.TypedValue;
import android.view.Gravity;
import android.widget.LinearLayout;
import android.widget.TextView;

/** Launcher entry point: starts the service and says whether the socket came up. */
public class MainActivity extends Activity {
    private TextView status;

    @Override
    protected void onCreate(Bundle saved) {
        super.onCreate(saved);
        status = new TextView(this);
        status.setTextSize(TypedValue.COMPLEX_UNIT_SP, 20);
        status.setTextColor(Color.WHITE);
        status.setGravity(Gravity.CENTER);

        LinearLayout root = new LinearLayout(this);
        root.setOrientation(LinearLayout.VERTICAL);
        root.setGravity(Gravity.CENTER);
        root.setBackgroundColor(Color.BLACK);
        root.addView(status);
        setContentView(root);
        setTitle("TV Remote Companion");
    }

    @Override
    protected void onStart() {
        super.onStart();
        try {
            startForegroundService(new Intent(this, CompanionService.class));
        } catch (Throwable t) {
            status.setText("Service start failed: " + t);
            return;
        }
        refresh();
    }

    private void refresh() {
        if (CompanionService.running) {
            status.setText(
                    CompanionService.paired
                            ? "Companion listening on loopback tcp/" + CompanionService.PORT + ", paired"
                            : "Companion on loopback tcp/" + CompanionService.PORT
                                    + ": no secret, refusing every connection (pair it from the remote)");
        } else if (CompanionService.lastError != null) {
            status.setText("Companion socket failed: " + CompanionService.lastError);
        } else {
            status.setText("Companion starting on loopback tcp/" + CompanionService.PORT);
        }
    }
}
