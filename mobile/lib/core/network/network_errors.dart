import 'package:dio/dio.dart';

bool isOfflineFailure(DioException error) =>
    error.response == null &&
    {
      DioExceptionType.connectionError,
      DioExceptionType.connectionTimeout,
      DioExceptionType.receiveTimeout,
      DioExceptionType.sendTimeout,
    }.contains(error.type);
