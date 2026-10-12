# Derived from wasi-sdk 34's share/cmake/wasi-sdk-p2.cmake.
# Hermes' CMake checks UNIX while selecting its platform support sources.
set(CMAKE_SYSTEM_NAME WASI)
set(CMAKE_SYSTEM_VERSION 1)
set(CMAKE_SYSTEM_PROCESSOR wasm32)
set(CMAKE_EXECUTABLE_SUFFIX .wasm)
set(triple wasm32-wasip2)

if(WIN32)
    set(WASI_HOST_EXE_SUFFIX ".exe")
else()
    set(WASI_HOST_EXE_SUFFIX "")
endif()

if(NOT WASI_SDK_PREFIX)
    message(FATAL_ERROR "WASI_SDK_PREFIX must point to the WASI SDK installation")
endif()

list(APPEND CMAKE_TRY_COMPILE_PLATFORM_VARIABLES WASI_SDK_PREFIX)
list(APPEND CMAKE_MODULE_PATH "${WASI_SDK_PREFIX}/share/cmake")

set(CMAKE_C_COMPILER "${WASI_SDK_PREFIX}/bin/clang${WASI_HOST_EXE_SUFFIX}")
set(CMAKE_CXX_COMPILER "${WASI_SDK_PREFIX}/bin/clang++${WASI_HOST_EXE_SUFFIX}")
set(CMAKE_ASM_COMPILER "${WASI_SDK_PREFIX}/bin/clang${WASI_HOST_EXE_SUFFIX}")
set(CMAKE_AR "${WASI_SDK_PREFIX}/bin/llvm-ar${WASI_HOST_EXE_SUFFIX}")
set(CMAKE_RANLIB "${WASI_SDK_PREFIX}/bin/llvm-ranlib${WASI_HOST_EXE_SUFFIX}")
set(CMAKE_C_COMPILER_TARGET ${triple})
set(CMAKE_CXX_COMPILER_TARGET ${triple})
set(CMAKE_ASM_COMPILER_TARGET ${triple})

# Do not look in the sysroot for executables to run during the build. Use only
# the SDK sysroot for target libraries, headers, and packages.
set(CMAKE_FIND_ROOT_PATH_MODE_PROGRAM NEVER)
set(CMAKE_FIND_ROOT_PATH_MODE_LIBRARY ONLY)
set(CMAKE_FIND_ROOT_PATH_MODE_INCLUDE ONLY)
set(CMAKE_FIND_ROOT_PATH_MODE_PACKAGE ONLY)

set(UNIX TRUE)
