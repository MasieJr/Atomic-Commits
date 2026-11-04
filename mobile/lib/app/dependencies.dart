import 'package:get_it/get_it.dart';

import '../core/network/api_client.dart';
import '../core/storage/token_storage.dart';
import '../features/auth/auth_controller.dart';
import '../features/auth/data/auth_api.dart';
import '../features/auth/data/auth_repository.dart';

final getIt = GetIt.instance;

Future<void> configureDependencies() async {
  final apiClient = ApiClient();
  final tokenStorage = TokenStorage();

  final authApi = AuthApi(apiClient);

  final authRepository = AuthRepository(
    authApi: authApi,
    tokenStorage: tokenStorage,
    apiClient: apiClient,
  );

  final authController = AuthController(authRepository);

  getIt.registerSingleton<ApiClient>(apiClient);
  getIt.registerSingleton<TokenStorage>(tokenStorage);
  getIt.registerSingleton<AuthApi>(authApi);
  getIt.registerSingleton<AuthRepository>(authRepository);
  getIt.registerSingleton<AuthController>(authController);

  await authController.initialize();
}
