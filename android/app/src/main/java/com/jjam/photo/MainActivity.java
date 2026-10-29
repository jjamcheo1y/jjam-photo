package com.jjam.photo;

import android.os.Bundle;
import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {
    @Override
    public void onCreate(Bundle savedInstanceState) {
        registerPlugin(PhotoFsPlugin.class);
        super.onCreate(savedInstanceState);
    }
}
