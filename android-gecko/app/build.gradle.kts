plugins {
    id("com.android.application")
}

val releaseKeystorePath = System.getenv("BKE_ANDROID_KEYSTORE_PATH")
val releaseKeystorePassword = System.getenv("BKE_ANDROID_KEYSTORE_PASSWORD")
val releaseKeyAlias = System.getenv("BKE_ANDROID_KEY_ALIAS")
val releaseKeyPassword = System.getenv("BKE_ANDROID_KEY_PASSWORD")
val hasReleaseSigning = listOf(
    releaseKeystorePath,
    releaseKeystorePassword,
    releaseKeyAlias,
    releaseKeyPassword,
).all { !it.isNullOrBlank() }

android {
    namespace = "com.bke.worker.gecko"
    compileSdk {
        version = release(37) {
            minorApiLevel = 1
        }
    }

    defaultConfig {
        applicationId = "com.bke.worker.gecko"
        minSdk = 26
        targetSdk = 36
        versionCode = 1
        versionName = "0.0.1"

        ndk {
            abiFilters += "arm64-v8a"
        }
    }

    signingConfigs {
        create("production") {
            if (hasReleaseSigning) {
                storeFile = file(releaseKeystorePath!!)
                storePassword = releaseKeystorePassword
                keyAlias = releaseKeyAlias
                keyPassword = releaseKeyPassword
            }
        }
    }

    buildTypes {
        getByName("debug") {
            isDebuggable = true
        }

        getByName("release") {
            isDebuggable = false
            isMinifyEnabled = false
            if (hasReleaseSigning) {
                signingConfig = signingConfigs.getByName("production")
            }
        }
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }
}

dependencies {
    implementation("org.mozilla.geckoview:geckoview-arm64-v8a:154.0.20260824154132")
    implementation("com.squareup.okhttp3:okhttp:4.12.0")
}
