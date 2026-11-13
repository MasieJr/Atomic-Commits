import 'package:atomic_commits/core/network/api_client.dart';
import 'package:atomic_commits/core/storage/token_storage.dart';
import 'package:atomic_commits/features/activity/data/payment_api.dart';
import 'package:atomic_commits/features/activity/data/payment_repository.dart';
import 'package:atomic_commits/features/activity/payment_controller.dart';
import 'package:atomic_commits/features/auth/auth_controller.dart';
import 'package:atomic_commits/features/auth/data/auth_api.dart';
import 'package:atomic_commits/features/auth/data/auth_repository.dart';
import 'package:get_it/get_it.dart';

final getIt = GetIt.instance;

Future<void> configureDependencies() async {
  final apiClient = ApiClient();
  final tokenStorage = TokenStorage();

  final authApi = AuthApi(apiClient);
  final paymentApi = PaymentApi(apiClient);

  final authRepository = AuthRepository(
    authApi: authApi,
    tokenStorage: tokenStorage,
    apiClient: apiClient,
  );

  final paymentRepository = PaymentRepository(paymentApi);
  final paymentController = PaymentController(paymentRepository);
  final authController = AuthController(authRepository);

  getIt.registerSingleton<ApiClient>(apiClient);
  getIt.registerSingleton<TokenStorage>(tokenStorage);
  getIt.registerSingleton<AuthApi>(authApi);
  getIt.registerSingleton<AuthRepository>(authRepository);
  getIt.registerSingleton<AuthController>(authController);
  getIt.registerSingleton<PaymentRepository>(paymentRepository);
  getIt.registerSingleton<PaymentController>(paymentController);

  await authController.initialize();
}
