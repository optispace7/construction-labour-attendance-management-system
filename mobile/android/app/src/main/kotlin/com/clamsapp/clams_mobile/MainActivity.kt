package com.clamsapp.clams_mobile

import io.flutter.embedding.android.FlutterActivity
import io.flutter.embedding.engine.FlutterEngine
import io.flutter.plugin.common.MethodChannel
import java.security.KeyStore

class MainActivity : FlutterActivity() {
    override fun configureFlutterEngine(flutterEngine: FlutterEngine) {
        super.configureFlutterEngine(flutterEngine)
        MethodChannel(flutterEngine.dartExecutor.binaryMessenger, "clams/secure_storage")
            .setMethodCallHandler { call, result ->
                if (call.method == "reset") {
                    try {
                        resetSecureStorage()
                        result.success(true)
                    } catch (e: Exception) {
                        result.error("RESET_FAILED", e.message, null)
                    }
                } else {
                    result.notImplemented()
                }
            }
    }

    /**
     * Wipes flutter_secure_storage down to nothing: its keystore keys and both of
     * its preference files. Called only after a write has failed.
     *
     * The plugin cannot repair itself when its keystore entry is unusable — it
     * logs "StorageCipher initialization failed" and every write then throws
     * "StorageCipher.encrypt on a null object reference", so sign-in is
     * impossible. With the key and files gone it makes new ones on the next
     * call. The names are the plugin's own (flutter_secure_storage 9.x).
     */
    private fun resetSecureStorage() {
        val keyStore = KeyStore.getInstance("AndroidKeyStore")
        keyStore.load(null)
        for (suffix in listOf(".FlutterSecureStoragePluginKey", ".FlutterSecureStoragePluginKeyOAEP")) {
            val alias = packageName + suffix
            if (keyStore.containsAlias(alias)) keyStore.deleteEntry(alias)
        }
        for (name in listOf("FlutterSecureStorage", "FlutterSecureKeyStorage")) {
            getSharedPreferences(name, MODE_PRIVATE).edit().clear().commit()
        }
    }
}
