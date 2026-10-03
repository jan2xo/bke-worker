plugins {
    id("com.android.application")
    kotlin("android")
}

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
        versionName = "0.0.1-probe"

        ndk {
            abiFilters += "arm64-v8a"
        }
    }

    buildTypes {
        getByName("debug") {
            isDebuggable = true
        }
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }
}

dependencies {
    implementation("org.mozilla.geckoview:geckoview-arm64-v8a:154.0.20260824154132")
}
