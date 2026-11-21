import 'package:dio/dio.dart';

/// Refresh failed without establishing that the session is invalid.
class RefreshFailure extends DioException {
  RefreshFailure({required super.requestOptions, required Object cause})
    : super(
        type: cause is DioException ? cause.type : DioExceptionType.unknown,
        response:
            cause is DioException &&
                cause.response?.statusCode != 401 &&
                cause.response?.statusCode != 403
            ? cause.response
            : null,
        error: cause,
        message: 'Session refresh temporarily unavailable',
      );
}

bool isOfflineFailure(DioException error) =>
    error is RefreshFailure ||
    error.response == null &&
        {
          DioExceptionType.connectionError,
          DioExceptionType.connectionTimeout,
          DioExceptionType.receiveTimeout,
          DioExceptionType.sendTimeout,
        }.contains(error.type);
