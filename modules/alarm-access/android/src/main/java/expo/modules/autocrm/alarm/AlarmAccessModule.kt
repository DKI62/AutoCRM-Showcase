package expo.modules.autocrm.alarm

import android.app.AlarmManager
import android.content.Intent
import android.net.Uri
import android.os.Build
import android.provider.Settings
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition

class AlarmAccessModule : Module() {
  override fun definition() = ModuleDefinition {
    Name("AutoCrmAlarmAccess")

    AsyncFunction("canSchedule") {
      val context = requireNotNull(appContext.reactContext)
      Build.VERSION.SDK_INT < Build.VERSION_CODES.S ||
        context.getSystemService(AlarmManager::class.java)?.canScheduleExactAlarms() == true
    }

    AsyncFunction("openSettings") {
      val context = requireNotNull(appContext.reactContext)
      if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
        context.startActivity(Intent(Settings.ACTION_REQUEST_SCHEDULE_EXACT_ALARM)
          .setData(Uri.fromParts("package", context.packageName, null))
          .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK))
      }
    }
  }
}
